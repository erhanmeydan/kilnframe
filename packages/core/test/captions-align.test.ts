import { describe, expect, it } from "vitest";
import { alignWords } from "../src/captions/align.js";

describe("alignWords", () => {
  it("gives a merged word the times of the words it came from", () => {
    const w = [
      { text: "Top", start: 12.0, end: 12.3 },
      { text: "View'e'nin", start: 12.3, end: 12.9 },
      { text: "dışına", start: 12.9, end: 13.4 },
    ];
    expect(alignWords(w, "TopView'in dışına")).toEqual([
      { text: "TopView'in", start: 12.0, end: 12.9 },
      { text: "dışına", start: 12.9, end: 13.4 },
    ]);
  });

  it("splits a word the correction split, sharing its time", () => {
    const w = [{ text: "napıyosun", start: 1, end: 2 }];
    expect(alignWords(w, "ne yapıyorsun")).toEqual([
      { text: "ne", start: 1, end: 1.5 },
      { text: "yapıyorsun", start: 1.5, end: 2 },
    ]);
  });

  it("keeps one-to-one corrections on their own times", () => {
    const w = [
      { text: "Cloud'a", start: 19.1, end: 19.6 },
      { text: "da", start: 19.6, end: 19.8 },
    ];
    expect(alignWords(w, "Claude'a da").map((x) => x.start)).toEqual([19.1, 19.6]);
  });

  it("folds a word the correction removed into the word next to it", () => {
    const w = [
      { text: "yani", start: 0, end: 1 },
      { text: "şey", start: 1, end: 2 },
      { text: "evet", start: 2, end: 3 },
    ];
    expect(alignWords(w, "yani evet")).toEqual([
      { text: "yani", start: 0, end: 1 },
      { text: "evet", start: 1, end: 3 },
    ]);
  });

  it("handles empty input on either side", () => {
    const w = [{ text: "bir", start: 0, end: 1 }];
    expect(alignWords(w, "  ")).toEqual([]);
    expect(alignWords([], "bir")).toEqual([{ text: "bir", start: 0, end: 0 }]);
  });

  describe("long chunks", () => {
    const vocabulary = ["bir", "iki", "üç", "dört", "beş", "altı", "yedi", "sekiz", "dokuz", "on"];
    function chunk(count: number) {
      return Array.from({ length: count }, (_, k) => ({
        text: `${vocabulary[(k * 7) % vocabulary.length]}${k}`,
        start: k * 0.4,
        end: k * 0.4 + 0.35,
      }));
    }

    it("aligns an 800 word chunk quickly", () => {
      const w = chunk(800);
      const text = w.map((x) => x.text).join(" ");
      const t0 = performance.now();
      const out = alignWords(w, text);
      const elapsed = performance.now() - t0;
      expect(out).toHaveLength(800);
      expect(elapsed).toBeLessThan(150);
    });

    it("keeps the right times around words merged and inserted mid-chunk", () => {
      const w = chunk(800);
      const words = w.map((x) => x.text);
      // merge words 400 and 401, insert a new word after 405, drop word 410
      const edited = [
        ...words.slice(0, 400),
        words[400]! + words[401]!,
        ...words.slice(402, 406),
        "eklenen",
        ...words.slice(406, 410),
        ...words.slice(411),
      ];
      const out = alignWords(w, edited.join(" "));
      expect(out).toHaveLength(edited.length);
      expect(out[400]).toMatchObject({ start: w[400]!.start, end: w[401]!.end });
      expect(out[401]).toMatchObject({ text: words[402], start: w[402]!.start });
      expect(out[405]).toMatchObject({ text: "eklenen" });
      expect(out[420]).toMatchObject({ text: words[421], start: w[421]!.start });
      expect(out[out.length - 1]).toMatchObject({ start: w[799]!.start, end: w[799]!.end });
    });

    it("never moves backwards in time", () => {
      const w = chunk(800);
      const words = w.map((x) => x.text);
      const edited = words.flatMap((t, k) => (k % 50 === 3 ? [t, "ek"] : k % 70 === 5 ? [] : [t]));
      const out = alignWords(w, edited.join(" "));
      for (let k = 1; k < out.length; k++) {
        expect(out[k]!.start).toBeGreaterThanOrEqual(out[k - 1]!.start);
        expect(out[k]!.end).toBeGreaterThanOrEqual(out[k]!.start);
      }
    });
  });
});
