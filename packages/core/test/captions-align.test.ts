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
});
