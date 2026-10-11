import { describe, expect, it } from "vitest";
import { sliceTranscript, splitIntoParts, wordsAround } from "../src/parts.js";
import type { Transcript } from "../src/schemas/transcript.js";

/** Sentences of `n` words at 2 words per second, with `gap` seconds of silence after each. */
function speech(sentences: number[], gap = 0.6): Transcript {
  const words: Transcript["words"] = [];
  let t = 0;
  sentences.forEach((n, s) => {
    for (let i = 0; i < n; i++) {
      words.push({ text: `k${s}_${i}${i === n - 1 ? "." : ""}`, start: t, end: t + 0.4 });
      t += 0.5;
    }
    t += gap;
  });
  return {
    version: 1,
    language: "tr",
    model: "test",
    duration_s: +t.toFixed(3),
    text: words.map((w) => w.text).join(" "),
    words,
  };
}

describe("parts", () => {
  it("keeps a short range as one part", () => {
    const t = speech([20, 20]);
    expect(splitIntoParts(t)).toEqual([{ startS: 0, endS: t.duration_s, text: t.text }]);
  });

  it("cuts a long range at sentence ends, near the target, never past the limits", () => {
    const t = speech(Array.from({ length: 20 }, (_, i) => 8 + (i % 4) * 3)); // about 4 minutes
    const parts = splitIntoParts(t, { targetS: 30, minS: 15, maxS: 45 });
    expect(parts.length).toBeGreaterThan(4);
    expect(parts[0]?.startS).toBe(0);
    expect(parts.at(-1)?.endS).toBe(t.duration_s);
    for (const [i, p] of parts.entries()) {
      const len = p.endS - p.startS;
      expect(len).toBeLessThanOrEqual(45);
      if (i < parts.length - 1) {
        expect(len).toBeGreaterThanOrEqual(15);
        expect(p.text.endsWith(".")).toBe(true);
        expect(parts[i + 1]?.startS).toBe(p.endS);
      }
    }
    expect(parts.map((p) => p.text).join(" ")).toBe(t.text);
  });

  it("still cuts a run with no sentence end within the limit", () => {
    const t = speech([200], 0);
    const parts = splitIntoParts(t);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.every((p) => p.endS - p.startS <= 45)).toBe(true);
  });

  it("gives each part its own transcript from zero", () => {
    const t = speech([10, 10, 10]);
    const [, second] = splitIntoParts(t, { targetS: 6, minS: 3, maxS: 7 });
    const part = sliceTranscript(t, second!.startS, second!.endS);
    expect(part.words[0]?.start).toBeGreaterThanOrEqual(0);
    expect(part.words[0]?.start).toBeLessThan(1);
    expect(part.text).toBe(second!.text);
    expect(part.words.every((w) => w.end <= part.duration_s)).toBe(true);
    expect(wordsAround("a b c d e", 2, "end")).toBe("d e");
  });
});
