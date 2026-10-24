import type { CaptionWord } from "./types.js";

const SKIP_COST = 1.5;
const EXTRA_WORD_COST = 0.1;

/** Lower-cased letters and digits only (Turkish locale), so punctuation never counts as a difference. */
function normalize(text: string): string {
  return text.toLocaleLowerCase("tr").replace(/[^\p{L}\p{N}]/gu, "");
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
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

/** Edit distance relative to the longer word: 0 for equal, 1 for nothing in common. */
function matchCost(a: string, b: string): number {
  const x = normalize(a);
  const y = normalize(b);
  const longest = Math.max(x.length, y.length);
  return longest === 0 ? 0 : levenshtein(x, y) / longest;
}

type Step = "one" | "merge" | "split" | "dropOriginal" | "dropCorrected";

/**
 * Carries the times of the original (Whisper) words over to a corrected text.
 * Words matched one to one keep their own times, a merged word spans the words it
 * came from, a split word shares its time equally, and a word with no source sits
 * at the end of the word before it.
 */
export function alignWords(original: CaptionWord[], corrected: string): CaptionWord[] {
  const target = corrected.split(/\s+/).filter(Boolean);
  const n = original.length;
  const m = target.length;
  if (m === 0) return [];
  if (n === 0) return target.map((text) => ({ text, start: 0, end: 0 }));

  const cost: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(Infinity),
  );
  const step: Step[][] = Array.from({ length: n + 1 }, () => new Array<Step>(m + 1).fill("one"));
  cost[0]![0] = 0;
  const relax = (i: number, j: number, value: number, how: Step) => {
    if (value < cost[i]![j]!) {
      cost[i]![j] = value;
      step[i]![j] = how;
    }
  };

  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const here = cost[i]![j]!;
      if (here === Infinity) continue;
      if (i < n && j < m)
        relax(i + 1, j + 1, here + matchCost(original[i]!.text, target[j]!), "one");
      if (i + 1 < n && j < m) {
        const joined = original[i]!.text + original[i + 1]!.text;
        relax(i + 2, j + 1, here + matchCost(joined, target[j]!) + EXTRA_WORD_COST, "merge");
      }
      if (i < n && j + 1 < m) {
        const joined = target[j]! + target[j + 1]!;
        relax(i + 1, j + 2, here + matchCost(original[i]!.text, joined) + EXTRA_WORD_COST, "split");
      }
      if (i < n) relax(i + 1, j, here + SKIP_COST, "dropOriginal");
      if (j < m) relax(i, j + 1, here + SKIP_COST, "dropCorrected");
    }
  }

  // Walk back from the end to collect the steps in order.
  const path: { how: Step; i: number; j: number }[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const how = step[i]![j]!;
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
