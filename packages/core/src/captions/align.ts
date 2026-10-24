import type { CaptionWord } from "./types.js";

const SKIP_COST = 1.5;
const EXTRA_WORD_COST = 0.1;

/** Lower-cased letters and digits only (Turkish locale), so punctuation never counts as a difference. */
function normalize(text: string): string {
  return text.toLocaleLowerCase("tr").replace(/[^\p{L}\p{N}]/gu, "");
}

function levenshtein(a: string, b: string): number {
  const prev = new Uint16Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = prev[j]!;
      prev[j] = Math.min(above + 1, prev[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return prev[b.length]!;
}

/** Edit distance between two already normalized words, relative to the longer: 0 for equal, 1 for nothing in common. */
function matchCost(x: string, y: string): number {
  if (x === y) return 0;
  const longest = Math.max(x.length, y.length);
  return longest === 0 ? 0 : levenshtein(x, y) / longest;
}

/** Half-width of the diagonal band the alignment searches, in words. */
const BAND = 30;

type Step = "one" | "merge" | "split" | "dropOriginal" | "dropCorrected";
const STEPS: Step[] = ["one", "merge", "split", "dropOriginal", "dropCorrected"];

/**
 * Carries the times of the original (Whisper) words over to a corrected text.
 * Words matched one to one keep their own times, a merged word spans the words it
 * came from, a split word shares its time equally, and a word the correction removed or
 * inserted is folded into its neighbour's time rather than skipped (a word with no
 * source at all sits at the end of the word before it). Words are normalized once and
 * the search is limited to a diagonal band, so long chunks stay fast.
 */
export function alignWords(original: CaptionWord[], corrected: string): CaptionWord[] {
  const target = corrected.split(/\s+/).filter(Boolean);
  const n = original.length;
  const m = target.length;
  if (m === 0) return [];
  if (n === 0) return target.map((text) => ({ text, start: 0, end: 0 }));

  const orig = original.map((w) => normalize(w.text));
  const tgt = target.map(normalize);

  // Only cells near the (m/n scaled) diagonal are searched. A row also reaches up to
  // the next row's diagonal so the band stays connected when the lengths differ a lot.
  const ratio = m / n;
  const lo = (i: number) => Math.max(0, Math.floor(i * ratio) - BAND);
  const hi = (i: number) => Math.min(m, Math.ceil((i + 1) * ratio) + BAND);

  const width = m + 1;
  const cost = new Float64Array((n + 1) * width).fill(Infinity);
  const stepAt = new Uint8Array((n + 1) * width);
  cost[0] = 0;
  const relax = (i: number, j: number, value: number, how: Step) => {
    if (j < lo(i) || j > hi(i)) return;
    const k = i * width + j;
    if (value < cost[k]!) {
      cost[k] = value;
      stepAt[k] = STEPS.indexOf(how);
    }
  };

  for (let i = 0; i <= n; i++) {
    const to = hi(i);
    for (let j = lo(i); j <= to; j++) {
      const here = cost[i * width + j]!;
      if (here === Infinity) continue;
      if (i < n && j < m) relax(i + 1, j + 1, here + matchCost(orig[i]!, tgt[j]!), "one");
      if (i + 1 < n && j < m)
        relax(
          i + 2,
          j + 1,
          here + matchCost(orig[i]! + orig[i + 1]!, tgt[j]!) + EXTRA_WORD_COST,
          "merge",
        );
      if (i < n && j + 1 < m)
        relax(
          i + 1,
          j + 2,
          here + matchCost(orig[i]!, tgt[j]! + tgt[j + 1]!) + EXTRA_WORD_COST,
          "split",
        );
      if (i < n) relax(i + 1, j, here + SKIP_COST, "dropOriginal");
      if (j < m) relax(i, j + 1, here + SKIP_COST, "dropCorrected");
    }
  }

  // Walk back from the end to collect the steps in order.
  const path: { how: Step; i: number; j: number }[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const how = STEPS[stepAt[i * width + j]!]!;
    if (how === "one") [i, j] = [i - 1, j - 1];
    else if (how === "merge") [i, j] = [i - 2, j - 1];
    else if (how === "split") [i, j] = [i - 1, j - 2];
    else if (how === "dropOriginal") i -= 1;
    else j -= 1;
    path.push({ how, i, j });
  }
  path.reverse();

  const result: CaptionWord[] = [];
  let lastEnd = original[0]!.start;
  for (const { how, i: oi, j: tj } of path) {
    if (how === "one") {
      const w = original[oi]!;
      result.push({ text: target[tj]!, start: w.start, end: w.end });
      lastEnd = w.end;
    } else if (how === "merge") {
      const first = original[oi]!;
      const last = original[oi + 1]!;
      result.push({ text: target[tj]!, start: first.start, end: last.end });
      lastEnd = last.end;
    } else if (how === "split") {
      const w = original[oi]!;
      const mid = w.start + (w.end - w.start) / 2;
      result.push({ text: target[tj]!, start: w.start, end: mid });
      result.push({ text: target[tj + 1]!, start: mid, end: w.end });
      lastEnd = w.end;
    } else if (how === "dropCorrected") {
      result.push({ text: target[tj]!, start: lastEnd, end: lastEnd });
    }
    // dropOriginal: the word is gone from the corrected text
  }
  return result;
}
