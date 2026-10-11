import type { Transcript } from "./schemas/transcript.js";

/**
 * Story mode knows the words it read aloud; Whisper only knows when they were said, and mishears names
 * ("Theia" came back as "T'ya", 7 Oct 2026). This keeps Whisper's timing and puts the script's words on it.
 *
 * The script and the heard words are aligned word by word (edit distance over words, a substitution costs
 * how different the two words look). The script's ends are free, so a transcript of only part of the
 * narration (an in/out range, one part of a long range) picks out its own stretch of the script. A matched
 * word keeps the heard word's times; script words with no heard partner share the time of the gap they sit
 * in, by length.
 */

/** Lowercase, Turkish aware, letters and digits only: what two spellings of one word have in common. */
export function normalizeWord(word: string): string {
  return word
    .toLocaleLowerCase("tr")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/** 0 for the same word, 1 for nothing in common (character edit distance over the longer length). */
export function wordDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a || !b) return 1;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]!;
      prev[j] = Math.min(up + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length]! / Math.max(a.length, b.length);
}

/** The script as words, punctuation kept on them the way Whisper writes them. */
export function scriptWords(script: string): string[] {
  return script.split(/\s+/).filter((w) => normalizeWord(w).length > 0);
}

/** Leaving a script word unheard is cheaper than leaving a heard word out of the script: what Whisper heard
 * was said, while a script word can hide inside a longer heard one ("4,5" for "dört buçuk"). */
const SKIP_SCRIPT = 0.6;
const SKIP_HEARD = 1;

export interface AlignResult {
  transcript: Transcript;
  /** Heard words whose text changed (for the log). */
  changed: { heard: string; script: string }[];
  /** How many heard words found a script word they resemble (distance under 0.5). */
  matched: number;
}

/**
 * The heard transcript with the script's words when the two clearly are the same speech (most heard words
 * found their script word); otherwise the heard one unchanged, so a wrong script never spoils the timing.
 */
export function correctTranscript(
  heard: Transcript,
  script: string,
  log?: (message: string) => void,
): Transcript {
  const r = alignToScript(heard, script);
  if (r.matched < heard.words.length * 0.6) {
    log?.(`Script not used: only ${r.matched}/${heard.words.length} heard words match it`);
    return heard;
  }
  log?.(`Words from the script: ${r.changed.length} corrected`);
  return r.transcript;
}

export function alignToScript(heard: Transcript, script: string): AlignResult {
  const s = scriptWords(script);
  const h = heard.words;
  const n = s.length;
  const m = h.length;
  if (!n || !m) return { transcript: heard, changed: [], matched: 0 };
  const sn = s.map(normalizeWord);
  const hn = h.map((w) => normalizeWord(w.text));
  // cost[i][j]: best alignment of script[0..i) with heard[0..j); skipping script words before the first
  // heard word and after the last one is free
  const W = m + 1;
  const cost = new Float64Array((n + 1) * W);
  const move = new Uint8Array((n + 1) * W); // 1 match, 2 script only, 3 heard only
  for (let j = 1; j <= m; j++) {
    cost[j] = j * SKIP_HEARD;
    move[j] = 3;
  }
  for (let i = 1; i <= n; i++) {
    cost[i * W] = 0;
    move[i * W] = 2;
    for (let j = 1; j <= m; j++) {
      const sub = cost[(i - 1) * W + j - 1]! + wordDistance(sn[i - 1]!, hn[j - 1]!);
      const skipS = cost[(i - 1) * W + j]! + (j === m ? 0 : SKIP_SCRIPT);
      const skipH = cost[i * W + j - 1]! + SKIP_HEARD;
      const best = Math.min(sub, skipS, skipH);
      cost[i * W + j] = best;
      move[i * W + j] = best === sub ? 1 : best === skipH ? 3 : 2;
    }
  }
  // walk back: pairs of (script index | null, heard index | null)
  const steps: [number | null, number | null][] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const mv = move[i * W + j];
    if (mv === 1) steps.push([--i, --j]);
    else if (mv === 3) steps.push([null, --j]);
    else steps.push([--i, null]);
  }
  steps.reverse();
  // drop the script words outside the heard stretch
  const firstHeard = steps.findIndex(([, hj]) => hj !== null);
  let lastHeard = steps.length - 1;
  while (lastHeard >= 0 && steps[lastHeard]![1] === null) lastHeard--;
  const inside = steps.slice(firstHeard, lastHeard + 1);

  // a pair that does not look alike ("4,5" heard for "dört buçuk") is no match: it joins the run around it
  const good = ([a, b]: [number | null, number | null]) =>
    a !== null && b !== null && wordDistance(sn[a]!, hn[b]!) < 0.5;
  const words: Transcript["words"] = [];
  const changed: AlignResult["changed"] = [];
  let matched = 0;
  // groups: runs between matched pairs; each run's script words share the run's time
  let k = 0;
  while (k < inside.length) {
    const [si, hj] = inside[k]!;
    if (si !== null && hj !== null && good(inside[k]!)) {
      const w = h[hj]!;
      const text = s[si]!;
      matched++;
      if (text !== w.text) changed.push({ heard: w.text, script: text });
      words.push({ text, start: w.start, end: w.end });
      k++;
      continue;
    }
    // an unmatched run: script words and heard words that found no partner
    const run: [number | null, number | null][] = [];
    while (k < inside.length && !good(inside[k]!)) run.push(inside[k++]!);
    const runScript = run.map(([a]) => a).filter((a): a is number => a !== null);
    const runHeard = run.map(([, b]) => b).filter((b): b is number => b !== null);
    if (!runScript.length) continue; // heard words the script does not have (a cough, a slip): drop them
    const from = runHeard.length ? h[runHeard[0]!]!.start : (words.at(-1)?.end ?? 0);
    const nextHeard = inside.slice(k).find(([, b]) => b !== null)?.[1];
    const to = runHeard.length
      ? h[runHeard.at(-1)!]!.end
      : nextHeard !== undefined && nextHeard !== null
        ? h[nextHeard]!.start
        : from;
    const total = runScript.reduce((a, si) => a + s[si]!.length, 0);
    let at = from;
    for (const si of runScript) {
      const len = ((to - from) * s[si]!.length) / total;
      words.push({ text: s[si]!, start: +at.toFixed(3), end: +(at + len).toFixed(3) });
      at += len;
    }
    if (runHeard.length)
      changed.push({
        heard: runHeard.map((b) => h[b]!.text).join(" "),
        script: runScript.map((a) => s[a]!).join(" "),
      });
  }
  return {
    transcript: { ...heard, text: words.map((w) => w.text).join(" "), words },
    changed,
    matched,
  };
}
