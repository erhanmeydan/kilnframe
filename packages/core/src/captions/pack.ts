import type { CaptionLine, CaptionWord } from "./types.js";

/**
 * A caption line as it travels between the panel and the companion: the words' texts and times in flat arrays
 * instead of one object per word, and the line's text only when it is not its words joined. A one-hour sequence
 * holds some 10,000 words; as objects they come close to a megabyte. Times on whole milliseconds (Whisper's)
 * go as milliseconds from the line's start, other times (an edited line's) as they are. Nothing is rounded: a
 * packed line unpacks to exactly the line it was.
 */
export interface PackedLine {
  /** Start and end, seconds. */
  s: number;
  e: number;
  /** The words' texts. */
  w: string[];
  /** The words' start and end as milliseconds from `s`, two per word, when every time is on a whole one. */
  d?: number[] | undefined;
  /** Otherwise the words' start and end in seconds, two per word. */
  m?: number[] | undefined;
  /** The text, when it is not the words joined with spaces. */
  t?: string | undefined;
  /** Changed by the correction or the editor. */
  c?: true | undefined;
}

/** Milliseconds from `fromMs` that give exactly `t` back, or null. */
function offset(t: number, fromMs: number): number | null {
  const d = Math.round(t * 1000) - fromMs;
  return (fromMs + d) / 1000 === t ? d : null;
}

export function packLines(lines: CaptionLine[]): PackedLine[] {
  return lines.map((line) => {
    const w = line.words.map((x) => x.text);
    const times = line.words.flatMap((x) => [x.start, x.end]);
    const fromMs = Math.round(line.start * 1000);
    const d = fromMs / 1000 === line.start ? times.map((t) => offset(t, fromMs)) : [null];
    const packed: PackedLine = d.every((x) => x !== null)
      ? { s: line.start, e: line.end, w, d: d as number[] }
      : { s: line.start, e: line.end, w, m: times };
    if (line.text !== w.join(" ")) packed.t = line.text;
    if (line.changed) packed.c = true;
    return packed;
  });
}

export function unpackLines(packed: PackedLine[]): CaptionLine[] {
  return packed.map((p) => {
    const fromMs = Math.round(p.s * 1000);
    const time = (k: number) => (p.d ? (fromMs + p.d[k]!) / 1000 : p.m![k]!);
    const words: CaptionWord[] = p.w.map((text, i) => ({
      text,
      start: time(2 * i),
      end: time(2 * i + 1),
    }));
    return {
      start: p.s,
      end: p.e,
      text: p.t ?? p.w.join(" "),
      words,
      changed: p.c === true,
    };
  });
}

const ms = (s: number) => Math.round(s * 1000) / 1000;

/** The lines with every time rounded to milliseconds (for what is kept on disk). */
export function msTimes(lines: CaptionLine[]): CaptionLine[] {
  return lines.map((line) => ({
    ...line,
    start: ms(line.start),
    end: ms(line.end),
    words: line.words.map((w) => ({ ...w, start: ms(w.start), end: ms(w.end) })),
  }));
}
