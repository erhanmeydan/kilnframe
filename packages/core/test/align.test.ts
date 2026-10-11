import { describe, expect, it } from "vitest";
import { alignToScript, correctTranscript, normalizeWord } from "../src/align.js";
import type { Transcript } from "../src/schemas/transcript.js";

function heard(text: string, gap = 0.1): Transcript {
  let t = 0;
  const words = text.split(" ").map((w) => {
    const word = { text: w, start: +t.toFixed(3), end: +(t + 0.4).toFixed(3) };
    t += 0.4 + gap;
    return word;
  });
  return { version: 1, language: "tr", model: "t", duration_s: t, text, words };
}

const SCRIPT =
  "Yaklaşık dört buçuk milyar yıl önce, genç Dünya'ya bir gök cismi çarptı. Bilim insanları ona Theia diyor.\n\nBu enkaz zamanla toplandı ve Ay doğdu.";

describe("transcript from the script", () => {
  it("folds case, Turkish dotless i and accents", () => {
    expect(normalizeWord("Dünya'ya,")).toBe("dunyaya");
    expect(normalizeWord("hâlâ")).toBe(normalizeWord("hala"));
    expect(normalizeWord("IŞIK")).toBe(normalizeWord("ışık"));
  });

  it("spells names as written and keeps Whisper's times", () => {
    const h = heard("Bilim insanları ona, T'ya diyor.");
    const r = alignToScript(h, SCRIPT);
    expect(r.transcript.words.map((w) => w.text)).toEqual([
      "Bilim",
      "insanları",
      "ona",
      "Theia",
      "diyor.",
    ]);
    expect(r.transcript.words[3]).toMatchObject({ start: h.words[3]!.start, end: h.words[3]!.end });
  });

  it("gives words heard as one their share of its time", () => {
    const h = heard("Yaklaşık 4,5 milyar yıl önce genç dünyaya");
    const words = alignToScript(h, SCRIPT).transcript.words;
    expect(words.slice(0, 4).map((w) => w.text)).toEqual(["Yaklaşık", "dört", "buçuk", "milyar"]);
    const [, dort, bucuk] = words;
    expect(dort!.start).toBeCloseTo(h.words[1]!.start, 3);
    expect(bucuk!.end).toBeCloseTo(h.words[1]!.end, 3);
    expect(dort!.end).toBeLessThanOrEqual(bucuk!.start + 1e-9);
  });

  it("leaves the transcript alone when the script is something else", () => {
    const h = heard("Bugün hava çok güzel, denize gidelim mi?");
    const logs: string[] = [];
    expect(correctTranscript(h, SCRIPT, (m) => logs.push(m))).toBe(h);
    expect(logs[0]).toMatch(/Script not used/);
  });
});
