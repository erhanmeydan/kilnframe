import { describe, expect, it } from "vitest";
import { TranscriptSchema, chunksToWords, downloadProgress, pickLanguage } from "../src/index.js";

describe("chunksToWords", () => {
  it("trims words, drops empty chunks and closes an open last word", () => {
    const words = chunksToWords(
      [
        { text: " Merhaba", timestamp: [0.2, 0.7] },
        { text: " ", timestamp: [0.7, 0.8] },
        { text: " dünya.", timestamp: [0.8, null] },
      ],
      2.5,
    );
    expect(words).toEqual([
      { text: "Merhaba", start: 0.2, end: 0.7 },
      { text: "dünya.", start: 0.8, end: 2.5 },
    ]);
  });

  it("clamps times into the audio and keeps order", () => {
    const words = chunksToWords(
      [
        { text: " bir", timestamp: [1.0, 1.4] },
        { text: " iki", timestamp: [0.9, 5.0] },
      ],
      3,
    );
    expect(words[1]).toEqual({ text: "iki", start: 1.0, end: 3 });
  });
});

describe("chunksToWords hallucinations", () => {
  it("drops words that start after the audio ends (Whisper on music or silence)", () => {
    const chunks = [
      { text: " Altyazı", timestamp: [29.98, 29.98] as [number, number] },
      { text: " M", timestamp: [29.98, 29.98] as [number, number] },
      { text: ".K.", timestamp: [29.98, 29.98] as [number, number] },
    ];
    expect(chunksToWords(chunks, 8)).toEqual([]);
    const mixed = [{ text: " Merhaba", timestamp: [0.5, 1.0] as [number, number] }, ...chunks];
    expect(chunksToWords(mixed, 8).map((w) => w.text)).toEqual(["Merhaba"]);
  });
});

describe("chunksToWords window seams", () => {
  it("keeps one copy of words repeated across a 30 s window seam", () => {
    const words = chunksToWords(
      [
        { text: " önce", timestamp: [23.5, 24.0] },
        { text: " Bir", timestamp: [25.34, 25.72] },
        { text: " yerli", timestamp: [25.72, 26.16] },
        { text: " yapışı", timestamp: [29.54, 29.98] },
        { text: "...", timestamp: [29.98, 29.98] },
        { text: " Bir", timestamp: [25.36, 25.72] },
        { text: " yerli", timestamp: [25.72, 26.18] },
        { text: " yapışı", timestamp: [29.5, 30.1] },
        { text: " sonra", timestamp: [30.2, 30.6] },
      ],
      36,
    );
    expect(words.map((w) => w.text)).toEqual(["önce", "Bir", "yerli", "yapışı", "sonra"]);
    expect(
      TranscriptSchema.safeParse({
        version: 1,
        language: "tr",
        model: "m",
        duration_s: 36,
        text: "x",
        words,
      }).success,
    ).toBe(true);
  });
});

describe("chunksToWords suffixes", () => {
  it("joins chunks without a leading space to the previous word", () => {
    const words = chunksToWords(
      [
        { text: " Prompt", timestamp: [4.28, 4.46] },
        { text: "'a", timestamp: [4.46, 5.04] },
        { text: " kamera", timestamp: [5.04, 5.24] },
      ],
      30,
    );
    expect(words).toEqual([
      { text: "Prompt'a", start: 4.28, end: 5.04 },
      { text: "kamera", start: 5.04, end: 5.24 },
    ]);
  });
});

describe("TranscriptSchema", () => {
  it("rejects words out of order", () => {
    const r = TranscriptSchema.safeParse({
      version: 1,
      language: "tr",
      model: "m",
      duration_s: 3,
      text: "iki bir",
      words: [
        { text: "iki", start: 1, end: 1.5 },
        { text: "bir", start: 0.5, end: 0.9 },
      ],
    });
    expect(r.success).toBe(false);
  });
});

describe("downloadProgress", () => {
  it("combines files into one percentage in 5 percent steps", () => {
    const seen: number[] = [];
    const on = downloadProgress((p) => seen.push(p));
    on({ status: "initiate", file: "a" });
    on({ status: "progress", file: "a", loaded: 10, total: 100 });
    on({ status: "progress", file: "b", loaded: 0, total: 100 });
    on({ status: "progress", file: "a", loaded: 100, total: 100 });
    on({ status: "progress", file: "b", loaded: 100, total: 100 });
    expect(seen).toEqual([10, 50, 100]);
  });
});

describe("pickLanguage", () => {
  it("returns the language code and its probability", () => {
    const r = pickLanguage([
      ["<|en|>", 1],
      ["<|tr|>", 9],
      ["<|de|>", 0],
    ]);
    expect(r.language).toBe("tr");
    expect(r.probability).toBeGreaterThan(0.99);
  });
});
