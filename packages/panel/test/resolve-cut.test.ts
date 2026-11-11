// Remove Pauses on Resolve: the bridge rebuilds the timeline from its source clips into a new one.
import { describe, expect, it } from "vitest";
import { createResolveBridge } from "../src/resolve/bridge";
import {
  makeFakeResolve,
  type FakeItem,
  type FakeOptions,
  type FakeTimeline,
} from "./fake-resolve";

const fast = { sleep: async () => undefined };
type Fake = ReturnType<typeof makeFakeResolve>;
const bridge = (f: Fake) => createResolveBridge(f.resolve as never, fast);
const rows = (items: FakeItem[]) => items.map((i) => [i.start, i.end, i.sourceIn, i.sourceOut]);

/** The footage on V1 and A1 starts 100 frames into its file. */
function withOffset(f: Fake) {
  for (const t of [f.project.timeline.tracks.video[0]!, f.project.timeline.tracks.audio[0]!]) {
    t.items[0]!.sourceIn = 100;
    t.items[0]!.sourceOut = 370;
  }
  return f;
}

describe("resolve cut to a new timeline", () => {
  it("cuts every track at the same frames, from the clips' own source frames", async () => {
    const f = withOffset(makeFakeResolve());
    const before = structuredClone(f.project.timeline.tracks);
    const b = bridge(f);
    const r = await b.cutToNewTimeline!(
      "tl-1",
      [
        { startS: 2, endS: 3 },
        { startS: 6, endS: 7 },
      ],
      "Probe (No Pauses)",
    );
    expect(r).toEqual({ id: "tl-2", name: "Probe (No Pauses)", leftOut: 0, rebuilt: true });
    const made = f.project.current;
    expect(made.id).toBe("tl-2");
    // frames 50..75 and 150..175 go; the source frames follow the timeline frames
    const want = [
      [90000, 90050, 100, 150],
      [90050, 90125, 175, 250],
      [90125, 90221, 275, 371],
    ];
    expect(rows(made.tracks.video[0]!.items)).toEqual(want);
    expect(rows(made.tracks.audio[0]!.items)).toEqual(want);
    // the original is left as it was
    expect(f.project.timeline.tracks).toEqual(before);
    expect(await b.cutProgress!()).toBeNull();
  });

  it("matches the tracks, leaves out titles and retimed clips and counts them", async () => {
    const f = withOffset(makeFakeResolve());
    const tracks = f.project.timeline.tracks;
    const one = (it: FakeItem) => ({ items: [it], enabled: true, locked: false });
    // a title (no media file), a clip at double speed, a clip lying wholly inside a cut
    tracks.video.push(
      one({ start: 90000, end: 90100, sourceIn: 0, sourceOut: 99, path: "" }),
      one({ start: 90000, end: 90100, sourceIn: 0, sourceOut: 200, path: "/broll.mp4" }),
      one({ start: 90055, end: 90070, sourceIn: 0, sourceOut: 15, path: "/flash.mp4" }),
    );
    tracks.audio[0]!.subType = "mono";
    tracks.audio.push({
      ...one({ start: 90000, end: 90271, sourceIn: 0, sourceOut: 271, path: "/lav.wav" }),
      enabled: false,
      subType: "stereo",
    });
    const r = await bridge(f).cutToNewTimeline!("tl-1", [{ startS: 2, endS: 3 }], "Cut");
    expect(r.leftOut).toBe(2);
    const made = f.project.current;
    expect(made.tracks.video.map((t) => t.items.length)).toEqual([2, 0, 0, 0]);
    expect(
      made.tracks.audio.map((t) => [t.subType ?? "stereo", t.enabled, t.items.length]),
    ).toEqual([
      ["mono", true, 2],
      ["stereo", false, 2],
    ]);
  });

  it("appends in batches of 200 and reports how far it got", async () => {
    const seen: unknown[] = [];
    const opts: FakeOptions = {};
    const f = makeFakeResolve(opts);
    const b = bridge(f);
    opts.onAppend = async () => void seen.push(await b.cutProgress!());
    // every other frame goes: 136 pieces on each of the two tracks
    const cuts = Array.from({ length: 135 }, (_, k) => ({
      startS: (2 * k + 1) / 25,
      endS: (2 * k + 2) / 25,
    }));
    await b.cutToNewTimeline!("tl-1", cuts, "Cut");
    expect(f.log.appends).toEqual([200, 72]);
    expect(seen).toEqual([
      { done: 0, total: 272 },
      { done: 200, total: 272 },
    ]);
    const made = f.project.current;
    expect(rows(made.tracks.video[0]!.items)).toEqual(rows(made.tracks.audio[0]!.items));
    expect(made.tracks.video[0]!.items.at(-1)).toMatchObject({
      start: 90135,
      end: 90136,
      sourceIn: 270,
    });
  });

  it("deletes the new timeline and gives the editor's timeline back when an append fails", async () => {
    const f = makeFakeResolve({ appendRefuses: "/footage.mp4" });
    // the editor looks at another timeline than the one being cut
    const other: FakeTimeline = {
      ...structuredClone(f.project.timeline),
      id: "tl-9",
      name: "Other",
    };
    f.project.timelines.push(other);
    f.project.current = other;
    const b = bridge(f);
    await expect(b.cutToNewTimeline!("tl-1", [{ startS: 2, endS: 3 }], "Cut")).rejects.toThrow(
      "PLACE_FAILED",
    );
    expect(f.project.timelines.map((t) => t.id)).toEqual(["tl-1", "tl-9"]);
    expect(f.project.current.id).toBe("tl-9");
    expect(await b.cutProgress!()).toBeNull();
  });

  it.each([
    ["29.97", "1", 30, 59],
    ["23.976", "0", 24, 47],
  ])("cuts a %s fps timeline (drop frame %s) on its own frame grid", async (rate, df, from, to) => {
    const f = makeFakeResolve();
    Object.assign(f.project.timeline.settings, {
      timelineFrameRate: rate,
      timelineDropFrameTimecode: df,
    });
    await bridge(f).cutToNewTimeline!("tl-1", [{ startS: 1, endS: 2 }], "Cut");
    const made = f.project.current;
    expect(made.settings).toMatchObject({
      useCustomSettings: "1",
      timelineFrameRate: rate,
      timelineDropFrameTimecode: df,
    });
    expect(rows(made.tracks.video[0]!.items)).toEqual([
      [90000, 90000 + from, 0, from],
      [90000 + from, 90000 + 271 - (to - from), to, 271],
    ]);
  });
});
