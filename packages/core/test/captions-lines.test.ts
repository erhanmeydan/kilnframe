import { describe, expect, it } from "vitest";
import {
  mergeLines,
  retimeLine,
  splitLineAt,
  splitLines,
  wrapRows,
} from "../src/captions/lines.js";
import type { CaptionLine, CaptionWord } from "../src/captions/types.js";

const reels: CaptionWord[] = (
  [
    ["Yapay", 0.22, 0.48],
    ["zekâ", 0.48, 0.92],
    ["ile", 0.92, 1.48],
    ["video", 1.48, 1.9],
    ["üretirken", 1.9, 2.5],
    ["kamera", 2.62, 3.0],
    ["hareketi", 3.0, 3.5],
    ["hep", 3.5, 3.7],
    ["sorundu.", 3.7, 4.1],
    ["Prompt'a", 4.28, 4.8],
    ['"kamera', 4.8, 5.2],
    ["yavaşça", 5.2, 5.7],
    ['dönsün"', 5.7, 6.1],
    ["yazıyoruz.", 6.14, 6.9],
    ["Model", 7.06, 7.4],
    ["her", 7.4, 7.6],
    ["seferinde", 7.6, 8.1],
    ["başka", 8.1, 8.5],
    ["türlü", 8.5, 8.86],
    ["yorumluyor.", 8.86, 9.4],
  ] as const
).map(([text, start, end]) => ({ text, start, end }));

function lineOf(texts: string[], from = 0, each = 0.5): CaptionLine {
  const words = texts.map((text, i) => ({
    text,
    start: from + i * each,
    end: from + (i + 1) * each,
  }));
  return {
    start: words[0]!.start,
    end: words[words.length - 1]!.end,
    text: texts.join(" "),
    words,
    changed: false,
  };
}

describe("splitLines", () => {
  it("breaks at sentence ends and pauses, never over maxChars per line", () => {
    const lines = splitLines(reels, { maxChars: 32, maxLines: 2 });
    expect(lines.map((l) => l.text)).toEqual([
      "Yapay zekâ ile video üretirken kamera hareketi hep sorundu.",
      'Prompt\'a "kamera yavaşça dönsün" yazıyoruz.',
      "Model her seferinde başka türlü yorumluyor.",
    ]);
    for (const line of lines) {
      for (const row of wrapRows(line.text, 32)) expect(row.length).toBeLessThanOrEqual(32);
      expect(wrapRows(line.text, 32).length).toBeLessThanOrEqual(2);
    }
    expect(lines.map((l) => l.changed)).toEqual([false, false, false]);
    expect([lines[0]!.start, lines[0]!.end]).toEqual([0.22, 4.1]);
  });

  it("joins a lone last word to a block that stops mid-sentence after a short pause", () => {
    const words: CaptionWord[] = [
      { text: "Bu", start: 0, end: 0.3 },
      { text: "çok", start: 0.3, end: 0.6 },
      { text: "iyi", start: 0.6, end: 0.9 },
      { text: "oldu.", start: 1.5, end: 1.9 },
    ];
    expect(splitLines(words, { maxChars: 32, maxLines: 2 }).map((l) => l.text)).toEqual([
      "Bu çok iyi oldu.",
    ]);
  });

  it("keeps a one-word sentence apart from a finished sentence", () => {
    const words: CaptionWord[] = [
      { text: "Bu", start: 0, end: 0.3 },
      { text: "iyi", start: 0.3, end: 0.6 },
      { text: "oldu.", start: 0.6, end: 1.0 },
      { text: "Evet.", start: 1.2, end: 1.5 },
    ];
    expect(splitLines(words, { maxChars: 32, maxLines: 2 }).map((l) => l.text)).toEqual([
      "Bu iyi oldu.",
      "Evet.",
    ]);
  });

  it("keeps a lone word apart after a long silence", () => {
    const words: CaptionWord[] = [
      { text: "Bu", start: 0, end: 0.3 },
      { text: "çok", start: 0.3, end: 0.6 },
      { text: "oldu.", start: 3, end: 3.4 },
    ];
    expect(splitLines(words, { maxChars: 32, maxLines: 2 })).toHaveLength(2);
  });

  it("keeps a lone word apart when the joined block would not fit", () => {
    const words: CaptionWord[] = [
      { text: "aaaaaaaaaa", start: 0, end: 0.3 },
      { text: "bbbbbbbbbb", start: 0.3, end: 0.6 },
      { text: "cccccccccc.", start: 1.1, end: 1.4 },
    ];
    expect(splitLines(words, { maxChars: 10, maxLines: 2 }).map((l) => l.text)).toEqual([
      "aaaaaaaaaa bbbbbbbbbb",
      "cccccccccc.",
    ]);
  });

  it("splits on a pause longer than pauseS", () => {
    const words: CaptionWord[] = [
      { text: "bir", start: 0, end: 0.2 },
      { text: "iki", start: 0.5, end: 0.7 },
      { text: "üç", start: 1.0, end: 1.2 },
    ];
    expect(splitLines(words, { maxChars: 32, maxLines: 2, pauseS: 0.2 })).toHaveLength(3);
    expect(splitLines(words, { maxChars: 32, maxLines: 2 })).toHaveLength(1);
  });

  it("keeps sakin to one line", () => {
    const lines = splitLines(reels, { maxChars: 32, maxLines: 1 });
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines) expect(line.text.length).toBeLessThanOrEqual(32);
    expect(lines.flatMap((l) => l.words)).toEqual(reels);
  });

  it("returns nothing for no words", () => {
    expect(splitLines([], { maxChars: 32, maxLines: 2 })).toEqual([]);
  });
});

describe("line editing", () => {
  const line4words = lineOf(["bir", "iki", "üç", "dört"], 10);

  it("drops a line whose text was emptied", () => {
    expect(retimeLine(line4words, "  ")).toBeNull();
  });

  it("splits a line at a word and merges two lines back", () => {
    const [a, b] = splitLineAt(line4words, 2);
    expect([a.end, b.start]).toEqual([line4words.words[1]!.end, line4words.words[2]!.start]);
    expect(a.text).toBe("bir iki");
    expect(b.text).toBe("üç dört");
    expect(mergeLines(a, b)).toEqual({ ...line4words, changed: false });
  });

  it("refuses to split outside the line", () => {
    expect(() => splitLineAt(line4words, 0)).toThrow(RangeError);
    expect(() => splitLineAt(line4words, 4)).toThrow(RangeError);
  });

  it("shares a line's time over the new words after an edit, keeping start and end", () => {
    const l = retimeLine(lineOf(["a", "b"], 2, 1), "a b c d")!;
    expect([l.start, l.end, l.words.length]).toEqual([2, 4, 4]);
    expect(l.changed).toBe(true);
    expect(l.words.map((w) => w.start)).toEqual([2, 2.5, 3, 3.5]);
    expect(l.words[3]!.end).toBe(4);
  });

  it("weights the shared time by word length", () => {
    const l = retimeLine(lineOf(["x", "y"], 0, 1), "ab cdef")!;
    expect(l.words[0]!.end).toBeCloseTo(2 / 3);
    expect(l.words[1]!.start).toBeCloseTo(2 / 3);
  });

  it("returns the same line, with its changed flag, when the text is unchanged", () => {
    const flagged = { ...line4words, changed: true };
    expect(retimeLine(flagged, "bir  iki üç dört ")).toEqual(flagged);
    expect(retimeLine(line4words, "bir iki üç dört")).toEqual(line4words);
  });
});
