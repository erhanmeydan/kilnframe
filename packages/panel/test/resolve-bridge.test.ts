import { describe, expect, it } from "vitest";
import { createResolveBridge } from "../src/resolve/bridge";
import { makeFakeResolve } from "./fake-resolve";

const fast = { sleep: async () => undefined };
const bridge = (r: ReturnType<typeof makeFakeResolve>) =>
  createResolveBridge(r.resolve as never, fast);

describe("resolve bridge", () => {
  it("reads the timeline relative to its start and maps the rate", async () => {
    const seq = await bridge(makeFakeResolve({ markIn: 50, markOut: 225 })).currentSequence();
    expect(seq).toMatchObject({
      id: "tl-1",
      name: "Probe",
      projectName: "Kilnframe Probe",
      fps: "25",
      fpsValue: 25,
      width: 1920,
      height: 1080,
      startFrame: 90000,
      inSeconds: 2,
      // Resolve's Out frame belongs to the range: 50..225 is 176 frames (measured in Resolve Studio 21.1.1)
      outSeconds: 226 / 25,
      videoTracks: 1,
      audioTracks: 1,
    });
    expect(seq.endSeconds).toBeCloseTo(271 / 25);
  });

  it("takes the whole timeline when no In/Out is set", async () => {
    const seq = await bridge(makeFakeResolve()).currentSequence();
    expect(seq.inSeconds).toBe(0);
    expect(seq.outSeconds).toBeCloseTo(271 / 25);
  });

  it("says NO_SEQUENCE when there is no project or no timeline", async () => {
    await expect(bridge(makeFakeResolve({ noTimeline: true })).currentSequence()).rejects.toThrow(
      "NO_SEQUENCE",
    );
    await expect(bridge(makeFakeResolve({ noProject: true })).currentSequence()).rejects.toThrow(
      "NO_SEQUENCE",
    );
  });

  it("renders the range's audio with absolute marks, starts only its own job and puts the user's settings back", async () => {
    const f = makeFakeResolve({ markIn: 50, markOut: 225 });
    const b = bridge(f);
    const seq = await b.currentSequence();
    const r = await b.exportRangeAudio(seq.id, 2, 9, "/jobs/a/sequence.wav");
    expect(r).toEqual({ ok: true, offsetSeconds: 2 });
    expect(f.log.renderSettings.at(-1)).toMatchObject({
      SelectAllFrames: false,
      MarkIn: 90050,
      MarkOut: 90224,
      TargetDir: "/jobs/a",
      CustomName: "sequence",
      ExportVideo: false,
      ExportAudio: true,
      AudioFormat: "wav",
    });
    expect(f.log.startRendering).toEqual([["job-1"]]);
    expect(f.log.deletedJobs).toEqual(["job-1"]);
    expect(f.log.presets).toEqual([
      "delete:Kilnframe Temp",
      "save:Kilnframe Temp",
      "load:Kilnframe Temp",
      "delete:Kilnframe Temp",
    ]);
    expect(f.log.pages.at(-1)).toBe("edit");
  });

  it("waits while the user's own render runs, then goes on", async () => {
    const f = makeFakeResolve({ renderingFor: 3 });
    const b = bridge(f);
    const seq = await b.currentSequence();
    await expect(b.exportRangeAudio(seq.id, 0, 1, "/x/a.wav")).resolves.toMatchObject({ ok: true });
  });

  it("gives up with RENDER_BUSY when the user's render does not end, starting nothing", async () => {
    const f = makeFakeResolve({ renderingFor: Infinity });
    const b = bridge(f);
    const seq = await b.currentSequence();
    await expect(b.exportRangeAudio(seq.id, 0, 1, "/x/a.wav")).rejects.toThrow("RENDER_BUSY");
    expect(f.log.startRendering).toEqual([]);
  });

  it("exports a frame at the right timecode and puts the playhead back", async () => {
    const f = makeFakeResolve({ playhead: "01:00:05:00" });
    const b = bridge(f);
    const seq = await b.currentSequence();
    expect(await b.exportFrame(seq.id, 3.4, "/jobs/a/footage-1.png")).toBe(true);
    expect(f.log.timecodes).toEqual(["01:00:03:10", "01:00:05:00"]);
  });

  it("tries a frame export once more when Resolve says no the first time", async () => {
    const f = makeFakeResolve({ failFirstStill: true });
    const b = bridge(f);
    const seq = await b.currentSequence();
    expect(await b.exportFrame(seq.id, 1, "/jobs/a/f.png")).toBe(true);
    expect(f.log.stills).toEqual(["/jobs/a/f.png"]);
  });

  it("places video and sfx on new top tracks at the In, trims the handles and restores In/Out and the playhead", async () => {
    const f = makeFakeResolve({ markIn: 50, markOut: 225, playhead: "01:00:07:00" });
    const b = bridge(f);
    const seq = await b.currentSequence();
    const placed = await b.placeInsert(
      seq.id,
      { video: "/m/Kilnframe/j/insert.mov", sfx: "/m/Kilnframe/j/sfx_mix.wav" },
      2,
      0.8,
      7,
    );
    expect(placed).toEqual({ videoTrack: 1, audioTrack: 1 });
    const v = f.project.timeline.tracks.video[1]!.items[0]!;
    expect([v.start, v.sourceIn, v.sourceOut, v.path]).toEqual([
      90050,
      20,
      194,
      "/m/Kilnframe/j/insert.mov",
    ]);
    const a = f.project.timeline.tracks.audio[1]!.items[0]!;
    expect([a.start, a.path]).toEqual([90050, "/m/Kilnframe/j/sfx_mix.wav"]);
    expect(f.project.timeline.mark).toEqual({ in: 50, out: 225 });
    expect(f.project.timeline.playhead).toBe("01:00:07:00");
  });

  it("reports PLACE_FAILED and takes the clip away when the track was locked", async () => {
    const f = makeFakeResolve({ lockTopVideoTrackOnAdd: true });
    const b = bridge(f);
    const seq = await b.currentSequence();
    await expect(
      b.placeInsert(seq.id, { video: "/m/Kilnframe/j/insert.mov", sfx: null }, 2, 0.8, 7),
    ).rejects.toThrow("PLACE_FAILED");
    expect(f.project.timeline.tracks.video.flatMap((t) => t.items)).toHaveLength(1);
  });

  it("reports PLACE_FAILED and takes the clip away when Resolve slid it off an occupied spot", async () => {
    const f = makeFakeResolve();
    const b = bridge(f);
    const seq = await b.currentSequence();
    // the footage track is occupied over the whole range
    await expect(
      b.placeInsert(seq.id, { video: "/m/Kilnframe/j/insert.mov", sfx: null }, 2, 0, 3, {
        videoTrack: 0,
        audioTrack: 0,
      }),
    ).rejects.toThrow("PLACE_FAILED");
    expect(f.project.timeline.tracks.video[0]!.items).toHaveLength(1);
  });

  it("reuses the tracks of an earlier part", async () => {
    const f = makeFakeResolve();
    const b = bridge(f);
    const seq = await b.currentSequence();
    const first = await b.placeInsert(
      seq.id,
      { video: "/m/Kilnframe/1/insert.mov", sfx: null },
      1,
      0,
      2,
    );
    await b.placeInsert(seq.id, { video: "/m/Kilnframe/2/insert.mov", sfx: null }, 4, 0, 2, first);
    expect(f.project.timeline.tracks.video[first.videoTrack]!.items).toHaveLength(2);
    expect(f.project.timeline.tracks.video).toHaveLength(2);
  });

  it("switches off only tracks holding our inserts over the range, and back on", async () => {
    const f = makeFakeResolve({ ourInsertOnV2: true });
    const b = bridge(f);
    const seq = await b.currentSequence();
    const hidden = await b.hideOurInserts(seq.id, 0, 10);
    expect(hidden).toEqual([{ type: "video", index: 2 }]);
    expect(f.project.timeline.tracks.video[1]!.enabled).toBe(false);
    expect(f.project.timeline.tracks.video[0]!.enabled).toBe(true);
    await b.showTracks(seq.id, hidden);
    expect(f.project.timeline.tracks.video[1]!.enabled).toBe(true);
  });

  it("opens a story timeline with the template's rate, the chosen frame and the narration on A1", async () => {
    const f = makeFakeResolve();
    const b = bridge(f);
    const seq = await b.currentSequence();
    await b.createStorySequence(
      seq.id,
      "Story: Moon",
      "/m/Kilnframe/s/narration.wav",
      "/m/Kilnframe/s/music.wav",
      "portrait",
    );
    const story = f.project.current;
    expect(story.name).toBe("Story: Moon");
    expect(story.settings).toMatchObject({
      useCustomSettings: "1",
      timelineResolutionWidth: "1080",
      timelineResolutionHeight: "1920",
      timelineFrameRate: "25",
    });
    expect(story.tracks.audio[0]!.items[0]).toMatchObject({
      start: 90000,
      path: "/m/Kilnframe/s/narration.wav",
    });
    expect(story.tracks.audio[1]!.items[0]).toMatchObject({
      start: 90000,
      path: "/m/Kilnframe/s/music.wav",
    });
  });

  it("finds a timeline that is no longer the current one by its id", async () => {
    const f = makeFakeResolve({ markIn: 50, markOut: 225 });
    const b = bridge(f);
    const seq = await b.currentSequence();
    await b.createStorySequence(seq.id, "Story", "/m/Kilnframe/s/narration.wav", null);
    await b.exportFrame(seq.id, 1, "/jobs/a/f.png");
    expect(f.project.current.name).toBe("Story");
    expect(f.log.stills).toEqual(["/jobs/a/f.png"]);
  });
});
