// packages/core/test/music-score-fit.test.ts
import { describe, expect, it } from "vitest";
import { SR } from "../src/music/score/audio-io.js";
import { bakeCrossfade, fade, fitLength } from "../src/music/score/fit.js";

const pad = (seconds: number, amp = 0.2) => {
  const x = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * 110 * i) / SR);
  return [x, x.slice()];
};
const len = (ch: Float32Array[]) => ch[0]!.length / SR;

describe("fitting music to a section", () => {
  it("loops a short piece to the exact length", () => {
    expect(len(fitLength(pad(20), 47.5, false))).toBeCloseTo(47.5, 3);
  });

  it("cuts a long piece to the exact length", () => {
    expect(len(fitLength(pad(90), 61.2, true))).toBeCloseTo(61.2, 3);
  });

  it("bakes the crossfade into the next clip's head: lengths add up, no seam", () => {
    const { prev, next } = bakeCrossfade(pad(30), pad(40), 2.5);
    expect(len(prev)).toBeCloseTo(27.5, 3);
    expect(len(next)).toBeCloseTo(40, 3);
  });

  it("loops a short piece before the crossfade is baked, so the baked tail is continuous music", () => {
    const fitted = fitLength(pad(20), 32.5, false); // section 30 s + 2.5 s handed to the next clip
    const { prev } = bakeCrossfade(fitted, pad(40), 2.5);
    expect(len(prev)).toBeCloseTo(30, 3);
  });

  it("fades in and out", () => {
    const f = fade(pad(10, 0.5), 0.3, 1);
    expect(Math.abs(f[0]![0]!)).toBeLessThan(0.01);
    expect(Math.abs(f[0]!.at(-1)!)).toBeLessThan(0.01);
  });
});
