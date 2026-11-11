import { describe, expect, it } from "vitest";
import { createFilmCraftBridge, TICKS } from "../src/filmcraft/bridge";
import {
  CUT_UNSUPPORTED,
  EXPORTS_STOPPED,
  NOT_RUNNING,
  COPY_LEFT,
  CUT_FAILED,
  PLACE_FAILED,
  RENDER_FAILED,
  UNSET_MARK,
} from "../src/resolve/api";
import { pickRange } from "../src/range";
import { makeFakeFilmCraft, type FakeFilmCraft } from "./fake-filmcraft";

const JOB = "/Users/ed/Movies/Kilnframe/job-1";
const files = { video: `${JOB}/insert.mov`, sfx: `${JOB}/sfx_mix.wav` };

const bridgeOf = (f: FakeFilmCraft) => createFilmCraftBridge(f.client);
const pathOf = (f: FakeFilmCraft, item: number) => f.state.media.get(item);
const clipsOf = (f: FakeFilmCraft, path: string) =>
  f.state.tracks().flatMap((t) => t.items.filter((c) => pathOf(f, c.item) === path));

/** Makes the first track sequence.addTracks adds come back locked. */
function lockAddedVideoTrack(f: FakeFilmCraft) {
  let added = false;
  f.state.before = (command) => {
    if (command === "sequence.addTracks") added = true;
    else if (added && command === "sequence.inspect") f.sequence.video.at(-1)!.locked = true;
  };
}

describe("filmcraft bridge", () => {
  it("reads the sequence's In, Out and fractional rate", async () => {
    const f = makeFakeFilmCraft({ inS: 2, outS: 6 });
    expect(await bridgeOf(f).currentSequence()).toMatchObject({
      id: String(f.sequence.id),
      name: "Sequence 1",
      projectName: "Short Film",
      fps: "30000/1001",
      fpsValue: 30000 / 1001,
      width: 1920,
      height: 1080,
      startFrame: 0,
      inSeconds: 2,
      outSeconds: 6,
      videoTracks: 1,
      audioTracks: 1,
    });
  });

  it("stops a running export when the job is stopped, past the shared connection", async () => {
    const f = makeFakeFilmCraft();
    f.state.holdExports = "cancel";
    const b = bridgeOf(f);
    const seq = await b.currentSequence();
    const exporting = b.exportRangeAudio(seq.id, 0, 2, "/x/a.wav");
    await expect.poll(() => f.state.log.at(-1)?.command).toBe("file.exportMedia");
    await b.cancelExports();
    await expect(exporting).rejects.toThrow(EXPORTS_STOPPED);
    expect(f.state.alone).toEqual(["export.queue.cancel"]);
  });

  it("ends the export's wait on a stop even when FilmCraft goes on exporting", async () => {
    const f = makeFakeFilmCraft();
    f.state.holdExports = "never";
    const b = bridgeOf(f);
    const seq = await b.currentSequence();
    const exporting = b.exportRangePicture(seq.id, 0, 2, "/x/footage.mp4");
    await expect.poll(() => f.state.log.at(-1)?.command).toBe("file.exportMedia");
    await b.cancelExports();
    await expect(exporting).rejects.toThrow(EXPORTS_STOPPED);
  });

  it("says RENDER_FAILED for an export FilmCraft refused, and a later export runs", async () => {
    const f = makeFakeFilmCraft();
    let refuse = true;
    f.state.before = (command) => {
      if (command === "file.exportMedia" && refuse) {
        refuse = false;
        throw new Error("no such format");
      }
    };
    const b = bridgeOf(f);
    const seq = await b.currentSequence();
    await expect(b.exportRangeAudio(seq.id, 0, 2, "/x/a.wav")).rejects.toThrow(
      `${RENDER_FAILED}: no such format`,
    );
    await expect(b.exportRangeAudio(seq.id, 0, 2, "/x/a.wav")).resolves.toEqual({
      ok: true,
      offsetSeconds: 0,
    });
  });

  it("reports unset marks as unset, so the panel takes the whole sequence", async () => {
    const f = makeFakeFilmCraft({ rate: { num: 25, den: 1 } });
    const seq = await bridgeOf(f).currentSequence();
    expect(seq.fps).toBe("25");
    expect(seq.inSeconds).toBe(UNSET_MARK);
    expect(seq.outSeconds).toBe(UNSET_MARK);
    expect(pickRange(seq.inSeconds, seq.outSeconds, seq.endSeconds).source).toBe("sequence");
  });

  it("puts the insert and its sounds on new tracks above the footage, on the frame of atS", async () => {
    const f = makeFakeFilmCraft();
    const b = bridgeOf(f);
    const seq = await b.currentSequence();
    await expect(b.placeInsert(seq.id, files, 2, 0.5, 4)).resolves.toEqual({
      videoTrack: 1,
      audioTrack: 1,
    });
    expect(f.sequence.video).toHaveLength(2);
    expect(f.sequence.audio).toHaveLength(2);
    const [video] = f.sequence.video[1]!.items;
    const [sfx] = f.sequence.audio[1]!.items;
    expect(pathOf(f, video!.item)).toBe(files.video);
    expect(pathOf(f, sfx!.item)).toBe(files.sfx);
    // 2 s at 29.97 fps is frame 60; the handles are 15 frames in
    for (const c of [video!, sfx!]) {
      expect(c.startFrame).toBe(60);
      expect(c.endFrame).toBe(60 + 120);
      expect(c.sourceIn).toBe(f.ticksOf(15));
    }
  });

  it("fits a 4K insert to an 8K sequence and leaves a 4K one alone", async () => {
    const fitted = (f: ReturnType<typeof makeFakeFilmCraft>) =>
      f.state.log.filter((l) => l.command === "clip.fitToFrame").map((l) => l.params);
    const big = makeFakeFilmCraft({ size: { width: 7680, height: 4320 } });
    const b = bridgeOf(big);
    const placed = await b.placeInsert((await b.currentSequence()).id, files, 2, 0.5, 4);
    expect(placed.scaleByHand).toBeUndefined();
    expect(fitted(big)).toEqual([{ clips: [big.sequence.video[1]!.items[0]!.clip] }]);

    const uhd = makeFakeFilmCraft({ size: { width: 3840, height: 2160 } });
    const u = bridgeOf(uhd);
    await u.placeInsert((await u.currentSequence()).id, files, 2, 0.5, 4);
    expect(fitted(uhd)).toEqual([]);
  });

  it("says the percent to set by hand on a FilmCraft without Fit to frame", async () => {
    const f = makeFakeFilmCraft({ size: { width: 7680, height: 4320 }, noFitToFrame: true });
    const b = bridgeOf(f);
    const placed = await b.placeInsert((await b.currentSequence()).id, files, 2, 0.5, 4);
    expect(placed.scaleByHand).toBe(200);
    // the clip stays where it was placed
    expect(f.sequence.video[1]!.items).toHaveLength(1);
  });

  it("refuses a locked track and takes the tracks it added off again", async () => {
    const f = makeFakeFilmCraft();
    lockAddedVideoTrack(f);
    const b = bridgeOf(f);
    const seq = await b.currentSequence();
    await expect(b.placeInsert(seq.id, files, 2, 0, 4)).rejects.toThrow(PLACE_FAILED);
    expect(f.sequence.video).toHaveLength(1);
    expect(f.sequence.audio).toHaveLength(1);
    expect(f.state.log.some((l) => l.command === "timeline.place")).toBe(false);
  });

  it("refuses a locked track it was given, leaving the editor's tracks alone", async () => {
    const f = makeFakeFilmCraft();
    f.sequence.video[0]!.locked = true;
    const b = bridgeOf(f);
    const seq = await b.currentSequence();
    await expect(
      b.placeInsert(seq.id, files, 2, 0, 4, { videoTrack: 0, audioTrack: 0 }),
    ).rejects.toThrow(PLACE_FAILED);
    expect(f.sequence.video).toHaveLength(1);
    expect(f.state.log.some((l) => l.command === "sequence.deleteTrack")).toBe(false);
  });

  it("takes a clip that landed on another frame off again and says PLACE_FAILED", async () => {
    const f = makeFakeFilmCraft();
    f.state.placeOffBy = 1;
    const b = bridgeOf(f);
    const seq = await b.currentSequence();
    await expect(b.placeInsert(seq.id, files, 2, 0, 4)).rejects.toThrow(PLACE_FAILED);
    expect(clipsOf(f, files.video)).toEqual([]);
    expect(f.sequence.video).toHaveLength(1);
    expect(f.sequence.audio).toHaveLength(1);
  });

  it("gives a 10 s insert at 29.97 fps a length of exactly 300 frames", async () => {
    const f = makeFakeFilmCraft();
    const b = bridgeOf(f);
    const seq = await b.currentSequence();
    await b.placeInsert(seq.id, { video: files.video, sfx: null }, 0, 0, 10);
    const place = f.state.log.find((l) => l.command === "timeline.place")!;
    expect(place.params.duration).toBe(f.ticksOf(300));
    expect(place.params.duration).toBe((300 * TICKS * 1001) / 30000);
    const [clip] = clipsOf(f, files.video);
    expect(clip!.endFrame - clip!.startFrame).toBe(300);
  });

  it("switches off only the tracks carrying our inserts, and the same ones back on", async () => {
    const f = makeFakeFilmCraft();
    f.state.addClip("video", files.video, 1, 5);
    f.state.addClip("audio", files.sfx, 1, 5);
    // the editor's own footage in a folder named Kilnframe is not ours
    f.state.addClip("video", "/Users/ed/Kilnframe/B-roll.mov", 1, 5);
    const b = bridgeOf(f);
    const seq = await b.currentSequence();
    const hidden = await b.hideOurInserts(seq.id, 0, 10);
    expect(hidden).toEqual([
      { type: "video", index: 2 },
      { type: "audio", index: 2 },
    ]);
    expect(f.state.tracks().map((t) => t.enabled)).toEqual([true, false, true, true, false]);
    await b.showTracks(seq.id, hidden);
    expect(f.state.tracks().every((t) => t.enabled)).toBe(true);
  });

  it("finds a clip whatever letter case or slashes its path came with", async () => {
    const f = makeFakeFilmCraft();
    f.state.addClip("video", `${JOB}/captions-1.mov`, 2, 4);
    f.state.addClip("video", "C:\\Users\\Ed\\Kilnframe\\job-2\\captions-1.mov", 6, 8);
    const b = bridgeOf(f);
    const seq = await b.currentSequence();
    await expect(
      b.findCaptionClip(seq.id, "/users/ed/movies/KILNFRAME/job-1/captions-1.mov", 2, 2),
    ).resolves.toEqual({ videoTrack: 1 });
    await expect(
      b.findCaptionClip(seq.id, "c:/users/ed/kilnframe/job-2/Captions-1.mov", 6, 2),
    ).resolves.toEqual({ videoTrack: 2 });
  });

  it("takes placed clips and added tracks off when FilmCraft goes away mid-job, and says so", async () => {
    const f = makeFakeFilmCraft();
    let placed = false;
    f.state.before = (command) => {
      if (command === "timeline.place") placed = true;
      // FilmCraft quits right after placing the insert, before the bridge has looked
      else if (placed) {
        f.quit();
        throw new Error(NOT_RUNNING);
      }
    };
    const b = bridgeOf(f);
    const seq = await b.currentSequence();
    await expect(b.placeInsert(seq.id, files, 2, 0, 4)).rejects.toThrow(NOT_RUNNING);
    const clip = f.sequence.video[1]!.items[0]!.clip;
    const after = f.state.log.slice(f.state.log.findIndex((l) => l.command === "timeline.place"));
    expect(after).toContainEqual({ command: "edit.clear", params: { clips: [clip] } });
    const added = [f.sequence.video[1]!.id, f.sequence.audio[1]!.id];
    for (const track of added)
      expect(after).toContainEqual({ command: "sequence.deleteTrack", params: { track } });
  });

  it("leaves nothing behind when the connection drops once mid-job and comes back", async () => {
    const f = makeFakeFilmCraft();
    let placed = false;
    let dropped = false;
    f.state.before = (command) => {
      if (command === "timeline.place") placed = true;
      else if (placed && !dropped) {
        dropped = true;
        throw new Error(NOT_RUNNING);
      }
    };
    const b = bridgeOf(f);
    const seq = await b.currentSequence();
    await expect(b.placeInsert(seq.id, files, 2, 0, 4)).rejects.toThrow(NOT_RUNNING);
    expect(clipsOf(f, files.video)).toEqual([]);
    expect(f.sequence.video).toHaveLength(1);
    expect(f.sequence.audio).toHaveLength(1);
  });
  describe("speech track", () => {
    /** A1 the footage, A2 a lav, A3 our music, A4 a clip after the range. */
    function withAudio() {
      const f = makeFakeFilmCraft();
      f.state.addClip("audio", "/Users/ed/Footage/lav.wav", 0, 30);
      f.state.addClip("audio", `${JOB}/music/s1.wav`, 0, 20);
      f.state.addClip("audio", "/Users/ed/Footage/room.wav", 12, 30);
      return f;
    }

    it("finds the audio tracks with the editor's own clips under the range", async () => {
      const f = withAudio();
      const b = bridgeOf(f);
      const seq = await b.currentSequence();
      expect(await b.speechTracks(seq.id, 2, 9)).toEqual([0, 1]);
    });

    it("switches off every other enabled audio track and the same ones back on", async () => {
      const f = withAudio();
      f.sequence.audio[3]!.enabled = false;
      const b = bridgeOf(f);
      const seq = await b.currentSequence();
      const hidden = await b.soloAudioTrack(seq.id, 1);
      expect(hidden).toEqual([
        { type: "audio", index: 1 },
        { type: "audio", index: 3 },
      ]);
      expect(f.sequence.audio.map((t) => t.enabled)).toEqual([false, true, false, false]);
      expect(f.sequence.video.every((t) => t.enabled)).toBe(true);
      await b.showTracks(seq.id, hidden);
      expect(f.sequence.audio.map((t) => t.enabled)).toEqual([true, true, true, false]);
    });

    it("switches the tracks back on when one cannot be switched off", async () => {
      const f = withAudio();
      let calls = 0;
      f.state.before = (command, params) => {
        if (command === "timeline.setTrack" && params.enabled === false && ++calls === 2)
          throw new Error("refused");
      };
      const b = bridgeOf(f);
      const seq = await b.currentSequence();
      await expect(b.soloAudioTrack(seq.id, 1)).rejects.toThrow();
      expect(f.sequence.audio.every((t) => t.enabled)).toBe(true);
    });
    it("leaves out earlier voice fix takes and disabled tracks", async () => {
      const f = withAudio();
      f.state.addClip("audio", `${JOB}/voice-fix/fix.wav`, 2, 6);
      f.state.addClip("audio", "C:\\Users\\Ed\\Kilnframe\\job-2\\voice-fix\\fix.wav", 2, 6);
      f.sequence.audio[1]!.enabled = false;
      const b = bridgeOf(f);
      const seq = await b.currentSequence();
      expect(await b.speechTracks(seq.id, 2, 9)).toEqual([0]);
    });
  });
});

describe("filmcraft cut to a new sequence", () => {
  const cuts = [
    { startS: 2, endS: 3 },
    { startS: 10, endS: 11 },
    { startS: 5, endS: 6.5 },
  ];
  /** The editor's footage on V1/A1 and a B-roll clip on V2 from 4 s to 12 s, at 29.97 fps. */
  function withBroll(opts: Parameters<typeof makeFakeFilmCraft>[0] = {}) {
    const f = makeFakeFilmCraft({ inS: 1, outS: 20, ...opts });
    f.state.addClip("video", "/Users/ed/Footage/B001.mov", 4, 12);
    return f;
  }
  const framesOf = (s: { start: number; end: number }) =>
    [s.start, s.end].map((t) => Math.round((t * 30000) / (1001 * TICKS)));
  const marks = (f: FakeFilmCraft) =>
    f.state.log.filter(
      (l) => l.command.startsWith("markers.mark") || l.command === "sequence.extract",
    );

  it("extracts every pause from a copy, last pause first, on frames, and leaves it open", async () => {
    const f = withBroll();
    const original = structuredClone(f.sequence);
    const b = bridgeOf(f);
    const r = await b.cutToNewTimeline!(String(f.sequence.id), cuts, "Sequence 1 (No Pauses)");

    const copy = f.state.active!;
    expect(copy.id).not.toBe(f.sequence.id);
    expect(r).toEqual({
      id: String(copy.id),
      name: "Sequence 1 (No Pauses)",
      leftOut: 0,
      rebuilt: false,
    });
    // [60, 89), [150, 194), [300, 329) at 29.97 fps: 102 frames out of 899
    expect(marks(f).map((l) => [l.command, l.params.frame])).toEqual([
      ["markers.markIn", 300],
      ["markers.markOut", 328],
      ["sequence.extract", undefined],
      ["markers.markIn", 150],
      ["markers.markOut", 193],
      ["sequence.extract", undefined],
      ["markers.markIn", 60],
      ["markers.markOut", 88],
      ["sequence.extract", undefined],
      // the editor's In (1 s, frame 30) and Out (20 s, frame 599, its last frame) follow their content
      ["markers.markIn", 30],
      ["markers.markOut", 599 - 102],
    ]);
    expect(
      marks(f)
        .filter((l) => l.command !== "sequence.extract")
        .every((l) => l.params.target === "program"),
    ).toBe(true);
    expect(Math.round(copy.duration / f.ticksOf(1))).toBe(899 - 102);
    // the B-roll moved with the footage: cut at the same frames, the pieces closed up
    expect(copy.video[1]!.items.map(framesOf)).toEqual([
      [91, 121],
      [121, 227],
      [227, 258],
    ]);
    expect(copy.in).toBe(f.ticksOf(30));
    expect(copy.out).toBe(f.ticksOf(497));
    // the editor's sequence, In and Out included, as it was
    expect(f.sequence).toEqual(original);
  });

  it("copies the sequence asked for, when another one is open", async () => {
    const f = withBroll();
    const b = bridgeOf(f);
    await f.client.exec("sequence.simplify", { name: "Other" });
    const other = f.state.active!;
    await b.cutToNewTimeline!(String(f.sequence.id), cuts, "Cut");
    expect(f.state.active!.name).toBe("Cut");
    expect(f.state.active!.video[1]!.items).toHaveLength(3);
    expect(other.video[1]!.items).toHaveLength(1);
  });

  it("reports its progress per pause while it runs, and none after", async () => {
    const f = withBroll();
    const b = bridgeOf(f);
    const seen: Promise<unknown>[] = [];
    f.state.before = (command) => {
      if (command === "sequence.extract") seen.push(b.cutProgress!());
    };
    await b.cutToNewTimeline!(String(f.sequence.id), cuts, "Cut");
    expect(await Promise.all(seen)).toEqual([
      { done: 0, total: 3 },
      { done: 1, total: 3 },
      { done: 2, total: 3 },
    ]);
    expect(await b.cutProgress!()).toBeNull();
  });

  it("says CUT_UNSUPPORTED on a FilmCraft without extract, before making anything", async () => {
    const f = withBroll({ without: ["sequence.extract"] });
    await expect(bridgeOf(f).cutToNewTimeline!(String(f.sequence.id), cuts, "Cut")).rejects.toThrow(
      CUT_UNSUPPORTED,
    );
    expect(f.state.sequences).toHaveLength(1);
    expect(f.state.log.map((l) => l.command)).not.toContain("sequence.simplify");
  });

  it("deletes the copy and opens the editor's sequence again when an extract fails", async () => {
    const f = withBroll();
    const b = bridgeOf(f);
    let n = 0;
    f.state.before = (command) => {
      if (command === "sequence.extract" && ++n === 2) throw new Error("extract failed");
    };
    // FilmCraft's reason kept for the log; the copy deleted with the measured project.delete
    await expect(b.cutToNewTimeline!(String(f.sequence.id), cuts, "Cut")).rejects.toThrow(
      `${CUT_FAILED}: extract failed`,
    );
    expect(f.state.log).toContainEqual({
      command: "project.delete",
      params: { items: [expect.any(Number)] },
    });
    expect(f.state.sequences).toEqual([f.sequence]);
    expect(f.state.active).toBe(f.sequence);
    expect(await b.cutProgress!()).toBeNull();
  });

  it("refuses a copy where a track did not follow the cut (a locked track), and deletes it", async () => {
    const f = withBroll();
    f.sequence.video[1]!.locked = true;
    await expect(bridgeOf(f).cutToNewTimeline!(String(f.sequence.id), cuts, "Cut")).rejects.toThrow(
      CUT_FAILED,
    );
    expect(f.state.sequences).toEqual([f.sequence]);
  });

  it("deletes a copy simplify made before it failed, found by its name", async () => {
    const f = withBroll();
    // a sequence already named like the copy is the editor's and stays
    await f.client.exec("sequence.simplify", { name: "Cut" });
    const theirs = f.state.active!;
    await f.client.exec("sequence.open", { item: f.sequence.id });
    f.state.before = (command) => {
      if (command !== "sequence.simplify") return;
      // FilmCraft made the copy, then failed before answering with its id
      f.state.sequences.push({ ...structuredClone(f.sequence), id: 9999, name: "Cut" });
      throw new Error("simplify failed");
    };
    await expect(bridgeOf(f).cutToNewTimeline!(String(f.sequence.id), cuts, "Cut")).rejects.toThrow(
      `${CUT_FAILED}: simplify failed`,
    );
    expect(f.state.sequences).toEqual([f.sequence, theirs]);
  });

  it("leaves the copy in the project when FilmCraft does not list how to delete it, and says so", async () => {
    const f = withBroll({ projectDelete: '{"confirm":bool?}' });
    f.state.before = (command) => {
      if (command === "sequence.extract") throw new Error("extract failed");
    };
    await expect(bridgeOf(f).cutToNewTimeline!(String(f.sequence.id), cuts, "Cut")).rejects.toThrow(
      `${CUT_FAILED}: ${COPY_LEFT}="Cut": extract failed`,
    );
    // an unknown shape might act on the editor's selection: not sent
    expect(f.state.log.map((l) => l.command)).not.toContain("project.delete");
    expect(f.state.sequences).toHaveLength(2);
    expect(f.state.active).toBe(f.sequence);
  });

  it("says FilmCraft went away as it is, not as a failed cut", async () => {
    const f = withBroll();
    f.state.before = (command) => {
      if (command === "sequence.extract") f.quit();
    };
    await expect(bridgeOf(f).cutToNewTimeline!(String(f.sequence.id), cuts, "Cut")).rejects.toThrow(
      NOT_RUNNING,
    );
  });
});
