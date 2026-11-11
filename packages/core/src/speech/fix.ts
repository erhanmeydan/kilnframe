import type { Word } from "../schemas/transcript.js";

/** A stretch of the recording, in seconds from the start of its audio. */
export interface Span {
  startS: number;
  endS: number;
}

/** The longest sample a clone is made from: ElevenLabs says more than about 3 minutes adds nothing. */
export const VOICE_SAMPLE_MAX_S = 180;

/** Less speech than this makes a poor clone; the caller decides what to do about it. */
export const VOICE_SAMPLE_MIN_S = 30;

const DEFAULT_TARGET_S = 90;
/** Silence kept between the fixed range and the sample. */
const RANGE_MARGIN_S = 0.3;
/** A pause longer than this ends a sentence even without punctuation. */
const SENTENCE_GAP_S = 0.6;
const CONTEXT_MAX_CHARS = 300;

const mid = (w: Word) => (w.start + w.end) / 2;

/** Splits the words into sentences: punctuation or a long pause ends one. */
function sentences(words: Word[]): Word[][] {
  const out: Word[][] = [];
  let cur: Word[] = [];
  words.forEach((w, i) => {
    cur.push(w);
    const next = words[i + 1];
    if (/[.!?…]["')\]”’]*$/.test(w.text) || (next && next.start - w.end > SENTENCE_GAP_S)) {
      out.push(cur);
      cur = [];
    }
  });
  if (cur.length) out.push(cur);
  return out;
}

const join = (words: Word[]) => words.map((w) => w.text).join(" ");

/** Whole sentences from `ordered` (nearest first) up to the character limit, cut at a word. */
function pickContext(ordered: Word[][], fromEnd: boolean): string {
  const taken: Word[] = [];
  for (const s of ordered) {
    const candidate = fromEnd ? [...s, ...taken] : [...taken, ...s];
    if (join(candidate).length <= CONTEXT_MAX_CHARS) {
      taken.splice(0, taken.length, ...candidate);
      continue;
    }
    if (taken.length === 0) {
      // The nearest sentence alone is too long: keep as many words next to the range as fit.
      const words = fromEnd ? [...s].reverse() : s;
      const kept: Word[] = [];
      for (const w of words) {
        const next = fromEnd ? [w, ...kept] : [...kept, w];
        if (join(next).length > CONTEXT_MAX_CHARS) break;
        kept.splice(0, kept.length, ...next);
      }
      return join(kept);
    }
    break;
  }
  return join(taken);
}

/** The text inside the range and the sentences just before and after it. */
export function fixContext(
  words: Word[],
  range: Span,
): { text: string; before: string; after: string } {
  const inside = words.filter((w) => mid(w) >= range.startS && mid(w) <= range.endS);
  const before = words.filter((w) => mid(w) < range.startS);
  const after = words.filter((w) => mid(w) > range.endS);
  return {
    text: join(inside),
    before: pickContext(sentences(before).reverse(), true),
    after: pickContext(sentences(after), false),
  };
}

/**
 * Sentence-sized spans around the range to clone the voice from, nearest first and
 * alternating before and after, until enough speech is gathered. The range itself
 * (plus a small margin) is never included.
 */
export function voiceSampleSpans(
  words: Word[],
  range: Span,
  o: { targetS?: number; maxS?: number } = {},
): { spans: Span[]; speechS: number } {
  const targetS = o.targetS ?? DEFAULT_TARGET_S;
  const maxS = o.maxS ?? VOICE_SAMPLE_MAX_S;
  const lo = range.startS - RANGE_MARGIN_S;
  const hi = range.endS + RANGE_MARGIN_S;

  const info = sentences(words).map((s) => ({
    span: { startS: s[0]!.start, endS: s[s.length - 1]!.end },
    speechS: s.reduce((sum, w) => sum + (w.end - w.start), 0),
  }));
  const usable = info.filter((s) => s.span.startS >= hi || s.span.endS <= lo);
  const before = usable.filter((s) => s.span.endS <= lo).reverse();
  const after = usable.filter((s) => s.span.startS >= hi);

  const chosen: Span[] = [];
  let speechS = 0;
  let b = 0;
  let a = 0;
  let takeBefore = true;
  while (speechS < targetS && (b < before.length || a < after.length)) {
    const side = (takeBefore && b < before.length) || a >= after.length ? before : after;
    const s = side === before ? before[b++]! : after[a++]!;
    takeBefore = !takeBefore;
    if (speechS + s.speechS > maxS) continue;
    chosen.push(s.span);
    speechS += s.speechS;
  }
  chosen.sort((x, y) => x.startS - y.startS);
  return { spans: chosen, speechS };
}
