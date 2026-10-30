import { describe, expect, it } from "vitest";
import { createFilmCraftBridge, TICKS } from "../src/filmcraft/bridge";
import { EXPORTS_STOPPED, NOT_RUNNING, PLACE_FAILED, RENDER_FAILED } from "../src/resolve/api";
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
    await expect(b.exportRangeAudio(seq.id, 0, 2, "/x/a.wav")).rejects.toThrow(RENDER_FAILED);
    await expect(b.exportRangeAudio(seq.id, 0, 2, "/x/a.wav")).resolves.toEqual({
      ok: true,
      offsetSeconds: 0,
    });
  });

  it("takes the whole sequence when no In/Out is set", async () => {
    const f = makeFakeFilmCraft({ rate: { num: 25, den: 1 } });
    const seq = await bridgeOf(f).currentSequence();
    expect(seq.fps).toBe("25");
    expect(seq.inSeconds).toBe(0);
    expect(seq.outSeconds).toBe(seq.endSeconds);
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
});
