// packages/core/test/music-score-levels.test.ts
import { describe, expect, it } from "vitest";
import {
  applyLevels,
  levelAt,
  limitPeak,
  meterLevelDb,
  normalizeTo,
  speechSpans,
} from "../src/music/score/levels.js";

const SR = 48_000;
const tone = (seconds: number, amp: number) => {
  const x = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * 220 * i) / SR);
  return [x, x.slice()];
};
const w = (start: number, end: number) => ({ text: "x", start, end });

describe("music levels", () => {
  it("reads a steady tone like a meter: its peak in dBFS", () => {
    expect(meterLevelDb(tone(3, 0.5), SR)).toBeCloseTo(-6.02, 1);
  });

  it("joins words across pauses shorter than 1.5 s into one span of speech", () => {
    expect(speechSpans([w(1, 1.5), w(2.5, 3), w(5, 5.4)])).toEqual([
      { start: 1, end: 3 },
      { start: 5, end: 5.4 },
    ]);
  });

  it("sits at S under speech, S+6 in gaps, ramps 0.3 s before a word and 0.5 s after", () => {
    const p = { slider: -21, rangeDurationS: 100, spans: [{ start: 10, end: 20 }] };
    expect(levelAt(5, p)).toBeCloseTo(-15);
    expect(levelAt(9.7, p)).toBeCloseTo(-15);
    expect(levelAt(9.85, p)).toBeCloseTo(-18);
    expect(levelAt(10, p)).toBeCloseTo(-21);
    expect(levelAt(15, p)).toBeCloseTo(-21);
    expect(levelAt(20.25, p)).toBeCloseTo(-18);
    expect(levelAt(20.5, p)).toBeCloseTo(-15);
  });

  it("rises to S+4 under speech over the last 20 s", () => {
    const p = { slider: -21, rangeDurationS: 100, spans: [{ start: 0, end: 100 }] };
    expect(levelAt(79, p)).toBeCloseTo(-21);
    expect(levelAt(90, p)).toBeCloseTo(-19);
    expect(levelAt(99.99, p)).toBeCloseTo(-17, 1);
  });

  it("moves every level with the slider", () => {
    const p = { slider: -25, rangeDurationS: 100, spans: [{ start: 10, end: 20 }] };
    expect(levelAt(15, p)).toBeCloseTo(-25);
    expect(levelAt(50, p)).toBeCloseTo(-19);
  });

  it("normalizes to a meter level, then follows the curve sample by sample", () => {
    const music = normalizeTo(tone(30, 0.3), SR, -15);
    expect(meterLevelDb(music, SR)).toBeCloseTo(-15, 1);
    // a longer range, so the last 20 s rise does not reach this stretch
    const p = { slider: -21, rangeDurationS: 100, spans: [{ start: 10, end: 20 }] };
    const out = applyLevels(music, SR, 0, p, -15);
    expect(meterLevelDb(out, SR, 12, 18)).toBeCloseTo(-21, 1);
    expect(meterLevelDb(out, SR, 2, 8)).toBeCloseTo(-15, 1);
  });

  it("never lets a sample pass -1.5 dBFS", () => {
    const loud = limitPeak(tone(1, 0.99));
    expect(Math.max(...loud[0]!.map(Math.abs))).toBeLessThanOrEqual(10 ** (-1.5 / 20) + 1e-6);
  });
});
