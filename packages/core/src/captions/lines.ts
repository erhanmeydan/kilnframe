import type { CaptionLine, CaptionWord } from "./types.js";

const DEFAULT_PAUSE_S = 0.45;

const SENTENCE_END = /[.!?…]["'”’»)]*$/u;

function endsSentence(word: CaptionWord): boolean {
  return SENTENCE_END.test(word.text);
}

/** Greedy wrap of words into rows no longer than maxChars (a longer single word gets its own row). */
function wrap(words: CaptionWord[], maxChars: number): CaptionWord[][] {
  const rows: CaptionWord[][] = [];
  let length = 0;
  for (const word of words) {
    const row = rows[rows.length - 1];
    if (row && length + 1 + word.text.length <= maxChars) {
      row.push(word);
      length += 1 + word.text.length;
    } else {
      rows.push([word]);
      length = word.text.length;
    }
  }
  return rows;
}

/** The rows a caption line is drawn on for a given row width. */
export function wrapRows(text: string, maxChars: number): string[] {
  const words = text
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => ({ text: t, start: 0, end: 0 }));
  return wrap(words, maxChars).map((row) => row.map((w) => w.text).join(" "));
}

function toLine(words: CaptionWord[], changed = false): CaptionLine {
  return {
    start: words[0]!.start,
    end: words[words.length - 1]!.end,
    text: words.map((w) => w.text).join(" "),
    words,
    changed,
  };
}

/**
 * Groups words into caption lines (blocks of up to maxLines rows). A block ends at
 * a sentence end, at a pause longer than pauseS, or when the next word would not fit.
 * A block holding only the last word of a sentence is joined to the block before when
 * that block stops mid-sentence, the gap is at most twice pauseS and the two fit together.
 */
export function splitLines(
  words: CaptionWord[],
  o: { maxChars: number; maxLines: 1 | 2; pauseS?: number },
): CaptionLine[] {
  const pauseS = o.pauseS ?? DEFAULT_PAUSE_S;
  const blocks: CaptionWord[][] = [];
  let block: CaptionWord[] = [];

  for (const word of words) {
    const previous = block[block.length - 1];
    if (previous) {
      const breaks = endsSentence(previous) || word.start - previous.end > pauseS;
      const fits = wrap([...block, word], o.maxChars).length <= o.maxLines;
      if (breaks || !fits) {
        blocks.push(block);
        block = [];
      }
    }
    block.push(word);
  }
  if (block.length > 0) blocks.push(block);

  const merged: CaptionWord[][] = [];
  for (const b of blocks) {
    const before = merged[merged.length - 1];
    const joins =
      before !== undefined &&
      b.length === 1 &&
      endsSentence(b[0]!) &&
      !endsSentence(before[before.length - 1]!) &&
      b[0]!.start - before[before.length - 1]!.end <= 2 * pauseS &&
      wrap([...before, ...b], o.maxChars).length <= o.maxLines;
    if (joins) before.push(...b);
    else merged.push(b);
  }
  return merged.map((b) => toLine(b));
}

/**
 * Applies an edited text to a line. The line keeps its start and end and the new
 * words share that time by character count. An empty text removes the line.
 */
export function retimeLine(line: CaptionLine, text: string): CaptionLine | null {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const joined = tokens.join(" ");
  if (joined === line.text) return line;

  const total = tokens.reduce((sum, t) => sum + t.length, 0);
  const span = line.end - line.start;
  let used = 0;
  const words = tokens.map((t, index) => {
    const start = line.start + (span * used) / total;
    used += t.length;
    const end = index === tokens.length - 1 ? line.end : line.start + (span * used) / total;
    return { text: t, start, end };
  });
  return { start: line.start, end: line.end, text: joined, words, changed: true };
}

/** Splits a line so the second part starts at the given word. */
export function splitLineAt(line: CaptionLine, wordIndex: number): [CaptionLine, CaptionLine] {
  if (wordIndex < 1 || wordIndex >= line.words.length) {
    throw new RangeError(`Cannot split a line of ${line.words.length} words at word ${wordIndex}`);
  }
  const first = line.words.slice(0, wordIndex);
  const second = line.words.slice(wordIndex);
  return [
    { ...toLine(first, line.changed), start: line.start, end: first[first.length - 1]!.end },
    { ...toLine(second, line.changed), start: second[0]!.start, end: line.end },
  ];
}

export function mergeLines(a: CaptionLine, b: CaptionLine): CaptionLine {
  const words = [...a.words, ...b.words];
  return {
    start: a.start,
    end: b.end,
    text: words.map((w) => w.text).join(" "),
    words,
    changed: a.changed || b.changed,
  };
}
