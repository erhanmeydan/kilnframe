import { describe, expect, it } from "vitest";
import {
  frameCuts,
  newEndF,
  piecesOf,
  seedLength,
  shiftAt,
  type FrameCut,
  type PlanItem,
} from "../src/cut-plan";

const NTSC = 30000 / 1001;

const item = (over: Partial<PlanItem> = {}): PlanItem => ({
  key: "v0:0",
  track: 0,
  kind: "video",
  startF: 0,
  endF: 300,
  ...over,
});

describe("frameCuts", () => {
  it("snaps to the frame grid inward: start up, end down (29.97 fps)", () => {
    // 1 s is frame 29.97: up to 30; 2 s is frame 59.94: down to 59
    expect(frameCuts([{ startS: 1, endS: 2 }], NTSC, 1000)).toEqual([{ startF: 30, endF: 59 }]);
  });

  it("keeps a cut that already lies on frames, despite float noise", () => {
    expect(
      frameCuts([{ startS: (30 * 1001) / 30000, endS: (60 * 1001) / 30000 }], NTSC, 1000),
    ).toEqual([{ startF: 30, endF: 60 }]);
    expect(frameCuts([{ startS: 0.4, endS: 1.2 }], 25, 1000)).toEqual([{ startF: 10, endF: 30 }]);
  });

  it("drops a cut shorter than a frame", () => {
    expect(frameCuts([{ startS: 1.01, endS: 1.05 }], 25, 1000)).toEqual([]);
    expect(frameCuts([{ startS: 1.01, endS: 1.07 }], 25, 1000)).toEqual([]);
  });

  it("clips to the sequence and drops what lies outside", () => {
    expect(
      frameCuts(
        [
          { startS: -1, endS: 1 },
          { startS: 9, endS: 20 },
          { startS: 30, endS: 40 },
        ],
        25,
        250,
      ),
    ).toEqual([
      { startF: 0, endF: 25 },
      { startF: 225, endF: 250 },
    ]);
  });

  it("sorts and merges overlapping and touching cuts", () => {
    expect(
      frameCuts(
        [
          { startS: 5, endS: 6 },
          { startS: 1, endS: 2 },
          { startS: 1.5, endS: 3 },
          { startS: 3, endS: 4 },
        ],
        25,
        1000,
      ),
    ).toEqual([
      { startF: 25, endF: 100 },
      { startF: 125, endF: 150 },
    ]);
  });
});

describe("shiftAt and newEndF", () => {
  const cuts: FrameCut[] = [
    { startF: 10, endF: 20 },
    { startF: 50, endF: 60 },
  ];
  it("counts the frames removed before a frame", () => {
    expect(shiftAt(cuts, 5)).toBe(0);
    expect(shiftAt(cuts, 15)).toBe(5);
    expect(shiftAt(cuts, 20)).toBe(10);
    expect(shiftAt(cuts, 55)).toBe(15);
    expect(shiftAt(cuts, 100)).toBe(20);
  });
  it("shortens the sequence's end by everything removed", () => {
    expect(newEndF(100, cuts)).toBe(80);
    expect(newEndF(100, [])).toBe(100);
  });
});

describe("piecesOf", () => {
  const cuts: FrameCut[] = [
    { startF: 30, endF: 40 },
    { startF: 100, endF: 130 },
    { startF: 200, endF: 205 },
  ];

  it("splits an item spanning three cuts into four contiguous pieces", () => {
    const p = piecesOf(item({ startF: 0, endF: 300 }), cuts);
    expect(p).toEqual([
      { fromF: 0, toF: 30, newStartF: 0 },
      { fromF: 40, toF: 100, newStartF: 30 },
      { fromF: 130, toF: 200, newStartF: 90 },
      { fromF: 205, toF: 300, newStartF: 160 },
    ]);
    for (let i = 1; i < p.length; i++)
      expect(p[i].newStartF).toBe(p[i - 1].newStartF + (p[i - 1].toF - p[i - 1].fromF));
    expect(seedLength(p)).toBe(30);
  });

  it("leaves nothing of an item inside a cut", () => {
    expect(piecesOf(item({ startF: 105, endF: 125 }), cuts)).toEqual([]);
    expect(piecesOf(item({ startF: 100, endF: 130 }), cuts)).toEqual([]);
    expect(seedLength([])).toBe(0);
  });

  it("keeps an item no cut touches whole, moved left", () => {
    expect(piecesOf(item({ startF: 150, endF: 180 }), cuts)).toEqual([
      { fromF: 150, toF: 180, newStartF: 110 },
    ]);
  });

  it("trims an item that starts or ends inside a cut", () => {
    expect(piecesOf(item({ startF: 35, endF: 110 }), cuts)).toEqual([
      { fromF: 40, toF: 100, newStartF: 30 },
    ]);
  });

  it("cuts every track at the same frames, so the same sequence frame lands together", () => {
    const video = piecesOf(item({ key: "v", startF: 0, endF: 300 }), cuts);
    const audio = piecesOf(
      item({ key: "a", track: 2, kind: "audio", startF: 20, endF: 260 }),
      cuts,
    );
    const broll = piecesOf(item({ key: "b", track: 1, startF: 120, endF: 210 }), cuts);
    const at = (pieces: typeof video, f: number) => {
      const p = pieces.find((x) => x.fromF <= f && f < x.toF)!;
      return p.newStartF + (f - p.fromF);
    };
    for (const f of [20, 45, 140, 199, 206, 250]) expect(at(audio, f)).toBe(at(video, f));
    for (const f of [130, 150, 207]) expect(at(broll, f)).toBe(at(video, f));
  });
});
