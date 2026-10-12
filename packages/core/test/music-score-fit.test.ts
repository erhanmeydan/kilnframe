// packages/core/test/music-score-fit.test.ts
import { describe, expect, it } from "vitest";
import { SR } from "../src/music/score/audio-io.js";
import { alignFinal, findHit } from "../src/music/score/final.js";
import { bakeCrossfade, fade, fitLength } from "../src/music/score/fit.js";

const pad = (seconds: number, amp = 0.2) => {
  const x = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * 110 * i) / SR);
  return [x, x.slice()];
};
/** A quiet bed with one loud decaying hit at `atS`. */
const withHit = (seconds: number, atS: number) => {
  const ch = pad(seconds, 0.05);
  for (const c of ch)
    for (let i = Math.round(atS * SR); i < c.length; i++) {
      const t = (i - atS * SR) / SR;
      c[i]! += 0.8 * Math.exp(-t * 3) * Math.sin(2 * Math.PI * 60 * t);
    }
  return ch;
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

describe("the final hit", () => {
  it("finds the hit in the last quarter", () => {
    expect(findHit(withHit(40, 33))).toBeCloseTo(33, 1);
  });

  it("finds nothing in a steady bed", () => {
    expect(findHit(pad(40))).toBeNull();
  });

  it("puts the hit on the last word's end when that is in the final 3 s", () => {
    const out = alignFinal({
      music: withHit(40, 33),
      hitS: 33,
      sectionStartS: 60,
      rangeDurationS: 100,
      lastWordEndS: 98.5,
    });
    expect(len(out)).toBeCloseTo(40, 3);
    expect(findHit(out)).toBeCloseTo(38.5, 1);
    expect(Math.abs(out[0]!.at(-1)!)).toBeLessThan(0.001);
  });

  it("puts the hit 2 s before the end when the speech ends earlier", () => {
    const out = alignFinal({
      music: withHit(40, 33),
      hitS: 33,
      sectionStartS: 60,
      rangeDurationS: 100,
      lastWordEndS: 90,
    });
    expect(findHit(out)).toBeCloseTo(38, 1);
  });

  it("fades a decay that would run past the last frame to silence on it", () => {
    const out = alignFinal({
      music: withHit(40, 33),
      hitS: 33,
      sectionStartS: 60,
      rangeDurationS: 100,
      lastWordEndS: 99.8,
    });
    expect(Math.abs(out[0]!.at(-1)!)).toBeLessThan(0.001);
  });
});
