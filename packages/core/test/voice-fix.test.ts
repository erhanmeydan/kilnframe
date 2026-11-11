import { describe, expect, it } from "vitest";
import type { Word } from "../src/schemas/transcript.js";
import { fixContext, voiceSampleSpans, VOICE_SAMPLE_MIN_S } from "../src/speech/fix.js";

function w(text: string, start: number, end: number): Word {
  return { text, start, end };
}

/** One-second words, a sentence every 5 words, from 0 to `totalS`. */
function synthetic(totalS: number): Word[] {
  const words: Word[] = [];
  for (let i = 0; i < totalS; i++) {
    words.push(w(i % 5 === 4 ? `w${i}.` : `w${i}`, i, i + 1));
  }
  return words;
}

describe("fixContext", () => {
  const words = [
    w("Bugün", 0, 0.4),
    w("hava", 0.5, 0.8),
    w("güzel.", 0.9, 1.3),
    w("Yarın", 2, 2.4),
    w("yağmur", 2.5, 2.9),
    w("var.", 3, 3.3),
    w("Sonra", 4, 4.4),
    w("güneş.", 4.5, 5),
  ];

  it("returns the range text and the sentences around it", () => {
    const c = fixContext(words, { startS: 1.95, endS: 3.35 });
    expect(c.text).toBe("Yarın yağmur var.");
    expect(c.before).toBe("Bugün hava güzel.");
    expect(c.after).toBe("Sonra güneş.");
  });

  it("cuts long context at a word within 300 characters", () => {
    const long: Word[] = [];
    for (let i = 0; i < 200; i++) long.push(w(`kelime${i}`, i * 0.5, i * 0.5 + 0.4));
    const c = fixContext(long, { startS: 50, endS: 52 });
    expect(c.before.length).toBeLessThanOrEqual(300);
    expect(c.after.length).toBeLessThanOrEqual(300);
    expect(c.before.endsWith("kelime99")).toBe(true);
  });
});

describe("voiceSampleSpans", () => {
  const overlaps = (s: { startS: number; endS: number }, a: number, b: number) =>
    s.startS < b && s.endS > a;

  it("avoids the range and reaches the target", () => {
    const { spans, speechS } = voiceSampleSpans(synthetic(300), { startS: 140, endS: 150 });
    expect(spans.length).toBeGreaterThan(0);
    for (const s of spans) expect(overlaps(s, 139.7, 150.3)).toBe(false);
    expect(speechS).toBeGreaterThanOrEqual(90);
    expect(speechS).toBeLessThanOrEqual(180);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]!.startS).toBeGreaterThanOrEqual(spans[i - 1]!.startS);
    }
  });

  it("takes only later speech when the range is at the start", () => {
    const { spans } = voiceSampleSpans(synthetic(300), { startS: 0, endS: 10 });
    expect(spans.length).toBeGreaterThan(0);
    for (const s of spans) expect(s.startS).toBeGreaterThanOrEqual(10.3);
  });

  it("reports too little speech without throwing", () => {
    const { speechS } = voiceSampleSpans(synthetic(20), { startS: 100, endS: 110 });
    expect(speechS).toBeLessThan(VOICE_SAMPLE_MIN_S);
  });
});
