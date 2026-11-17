// Long recordings are read in parts, by several speech processes at once (runSpeechParts in transcribe.ts).
// This file holds the pure parts: where to cut, how many processes a computer can take, and how the words of
// the parts become one transcript.
import type { Word } from "../schemas/transcript.js";
import { chunksToWords, type AsrChunk } from "./transcribe.js";

/** A stretch of the recording, in samples (end exclusive). */
export interface Part {
  start: number;
  end: number;
}

export interface PartOptions {
  /** How long a part is meant to be, in seconds. */
  targetS?: number;
  /** How far before or after that length the cut may move to find quiet, in seconds. */
  searchS?: number;
  /** Below this, the rest of the recording joins the last part instead of standing alone. */
  minS?: number;
}

const FRAME_S = 0.05;
/** The quiet a cut needs: the softest stretch of this length around the target is where it goes. */
const QUIET_S = 0.4;

/**
 * Cuts a recording into parts of about `targetS` seconds, each cut in the softest moment near its target,
 * so it falls between words, not inside one. A recording up to `targetS + minS` long stays one part and is
 * read exactly as before.
 */
export function planParts(audio: Float32Array, sampleRate: number, o: PartOptions = {}): Part[] {
  const targetS = o.targetS ?? 120;
  const searchS = o.searchS ?? 15;
  const minS = o.minS ?? 30;
  const total = audio.length;
  if (total / sampleRate <= targetS + minS) return [{ start: 0, end: total }];

  const frame = Math.max(1, Math.round(FRAME_S * sampleRate));
  const frames = Math.ceil(total / frame);
  const energy = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const end = Math.min(total, (f + 1) * frame);
    for (let i = f * frame; i < end; i++) sum += (audio[i] ?? 0) ** 2;
    energy[f] = sum / Math.max(1, end - f * frame);
  }
  const span = Math.max(1, Math.round(QUIET_S / FRAME_S));

  const parts: Part[] = [];
  let start = 0;
  while ((total - start) / sampleRate > targetS + minS) {
    const target = start / frame + targetS / FRAME_S;
    const lo = Math.max(
      Math.ceil(start / frame) + Math.round(minS / FRAME_S),
      Math.round(target - searchS / FRAME_S),
    );
    const hi = Math.min(
      frames - span - Math.round(minS / FRAME_S),
      Math.round(target + searchS / FRAME_S),
    );
    let best = Math.round(target);
    let bestSum = Infinity;
    let sum = 0;
    for (let f = lo; f < lo + span; f++) sum += energy[f] ?? 0;
    for (let f = lo; f <= hi; f++) {
      // the softest window; on a tie the one nearest the target, so even parts stay even
      if (
        sum < bestSum ||
        (sum === bestSum && Math.abs(f + span / 2 - target) < Math.abs(best - target))
      ) {
        bestSum = sum;
        best = f + Math.floor(span / 2);
      }
      sum += (energy[f + span] ?? 0) - (energy[f] ?? 0);
    }
    const cut = Math.min(total, best * frame);
    parts.push({ start, end: cut });
    start = cut;
  }
  parts.push({ start, end: total });
  return parts;
}

/**
 * Where the speech begins, in samples: the first frame louder than a hundredth of the recording's loud
 * level (its 95th percentile) that starts a second at least half loud, less half a second. A click in a
 * silent opening is one loud frame, not speech: 30 seconds of silence read from it were taken for English.
 */
export function speechStart(audio: Float32Array, sampleRate: number): number {
  const frame = Math.max(1, Math.round(FRAME_S * sampleRate));
  const frames = Math.floor(audio.length / frame);
  if (frames === 0) return 0;
  const energy = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * frame; i < (f + 1) * frame; i++) sum += (audio[i] ?? 0) ** 2;
    energy[f] = sum / frame;
  }
  const loud = [...energy].sort((a, b) => a - b)[Math.floor(frames * 0.95)] ?? 0;
  if (loud === 0) return 0;
  const isLoud = Array.from(energy, (e) => (e > loud / 100 ? 1 : 0));
  const run = Math.min(frames, Math.max(1, Math.round(1 / FRAME_S)));
  let count = 0;
  for (let f = 0; f < run; f++) count += isLoud[f] ?? 0;
  for (let f = 0; f + run <= frames; f++) {
    if (isLoud[f] && count * 2 >= run) return Math.max(0, f * frame - Math.round(0.5 * sampleRate));
    count += (isLoud[f + run] ?? 0) - (isLoud[f] ?? 0);
  }
  return 0;
}

/** Seconds of speech Whisper tells the language from. */
export const LANGUAGE_WINDOW_S = 30;

/**
 * Where the 30-second windows the language is told from begin, in samples: up to three, spread from where
 * the speech begins to the end, so one quiet or silent stretch cannot decide it alone. A minute or less of
 * speech gets one window, up to a minute and a half two.
 */
export function languageWindows(audio: Float32Array, sampleRate: number): number[] {
  const from = speechStart(audio, sampleRate);
  const window = LANGUAGE_WINDOW_S * sampleRate;
  const span = audio.length - from;
  const count = span > 3 * window ? 3 : span > 2 * window ? 2 : 1;
  if (count === 1) return [from];
  const last = audio.length - window;
  return Array.from({ length: count }, (_, k) =>
    Math.round(from + ((last - from) * k) / (count - 1)),
  );
}

/**
 * The language most likely over several windows: each window's probabilities added up, so a window that
 * is sure outweighs one that is guessing. The probability is the winner's average.
 */
export function voteLanguage(windows: Record<string, number>[]): {
  language: string;
  probability: number;
} {
  const total = new Map<string, number>();
  for (const w of windows)
    for (const [k, v] of Object.entries(w)) total.set(k, (total.get(k) ?? 0) + v);
  const [top] = [...total].sort((a, b) => b[1] - a[1]);
  if (!top) throw new Error("No language scores to choose from.");
  return { language: top[0], probability: top[1] / windows.length };
}

export interface Machine {
  totalMemoryBytes: number;
  /** os.availableParallelism() */
  cores: number;
}

const GB = 1024 ** 3;
/** What the speech model takes while it reads: 5.0 to 5.6 GB measured on Apple silicon (whisper-large-v3-turbo, q8). */
export const SPEECH_PROCESS_GB = 5.5;
/**
 * Measured on a 35-minute recording (M5 Max): one process 694 s, two 366 s, three 417 s, four 253 s; on a
 * 10-minute one the gain was under 10 percent and four were slower. Two pay every time; more do not.
 */
export const MAX_SPEECH_PROCESSES = 2;
/** Left for macOS or Windows, Premiere (or Resolve) with its project open, and the job itself. */
export const RESERVED_GB = 12;
/** Under this much audio one process is quicker: loading more models costs more than they save. */
export const PARALLEL_MIN_S = 180;

/**
 * How many speech processes may read at once. Each takes about SPEECH_PROCESS_GB; the editor keeps its share,
 * so an 8 or 16 GB computer reads with one, as before, and 24 GB or more with two. Each process needs about four of
 * the three quarters of the cores left for others.
 */
export function speechProcesses(machine: Machine, durationS: number): number {
  if (durationS < PARALLEL_MIN_S) return 1;
  const usable = Math.floor(machine.cores * 0.75);
  const byMemory = Math.floor((machine.totalMemoryBytes / GB - RESERVED_GB) / SPEECH_PROCESS_GB);
  return Math.max(1, Math.min(MAX_SPEECH_PROCESSES, byMemory, Math.floor(usable / 4)));
}

/**
 * Threads for each process's model: the usable cores shared out, at least two. One process keeps the
 * runtime's own choice (undefined), as before.
 */
export function speechThreads(machine: Machine, processes: number): number | undefined {
  if (processes <= 1) return undefined;
  return Math.max(2, Math.floor(Math.floor(machine.cores * 0.75) / processes));
}

/**
 * The words of every part, in order, placed at their time in the whole recording. Each part's chunks are
 * cleaned as one short recording would be (chunksToWords); the cuts are in quiet, so no word spans two parts.
 */
export function joinParts(parts: Part[], chunks: AsrChunk[][], sampleRate: number): Word[] {
  const words: Word[] = [];
  parts.forEach((part, i) => {
    const offset = part.start / sampleRate;
    const durationS = (part.end - part.start) / sampleRate;
    for (const w of chunksToWords(chunks[i] ?? [], durationS)) {
      const start = w.start + offset;
      // never before the last word: a part's first word can be timed a hair early, into the cut
      const prev = words[words.length - 1];
      const at = prev ? Math.max(start, prev.start) : start;
      words.push({ text: w.text, start: at, end: Math.max(w.end + offset, at) });
    }
  });
  return words;
}

/** "Transcribing: 40%" from the seconds read so far, in 5 percent steps (the panel shows it). */
export function partsProgress(
  report: (percent: number) => void,
): (doneS: number, totalS: number) => void {
  let last = -1;
  return (doneS, totalS) => {
    const step = Math.floor((Math.min(1, doneS / Math.max(totalS, 1e-9)) * 100) / 5) * 5;
    if (step > last) {
      last = step;
      report(step);
    }
  };
}
