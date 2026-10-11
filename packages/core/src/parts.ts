import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { correctTranscript } from "./align.js";
import type { Defaults } from "./config.js";
import { cutAudio } from "./media/audio.js";
import { TranscriptSchema, type Transcript } from "./schemas/transcript.js";
import { transcribe } from "./stages/transcribe.js";

/**
 * Long ranges (over a minute) are made in parts: each part is
 * its own insert with the same style, cut where the speaker pauses at the end of a sentence, so no scene
 * ever starts mid sentence and a failed or rejected part costs only itself.
 */

export interface Part {
  /** Seconds from the start of the transcript's audio. */
  startS: number;
  endS: number;
  text: string;
}

export interface PartOptions {
  /** Aim for parts about this long. */
  targetS?: number;
  /** Never shorter than this, except the last one when the rest is short. */
  minS?: number;
  /** Never longer than this. */
  maxS?: number;
}

/** True when a word closes a sentence. */
const sentenceEnd = (word: string) => /[.!?…]["'”’)]*$/.test(word);

/**
 * Splits a transcript into parts. Candidate cuts are the gaps between words; a cut scores higher for a
 * longer pause and much higher after a sentence end, and lower the further it lands from the target length.
 * A range that fits into maxS stays one part.
 */
export function splitIntoParts(transcript: Transcript, o: PartOptions = {}): Part[] {
  const targetS = o.targetS ?? 30;
  const minS = o.minS ?? 15;
  const maxS = o.maxS ?? 45;
  const words = transcript.words;
  const end = transcript.duration_s;
  if (end <= maxS || words.length < 2)
    return [{ startS: 0, endS: end, text: transcript.text.trim() }];
  const parts: Part[] = [];
  let start = 0;
  let first = 0;
  while (end - start > maxS) {
    let best = -1;
    let bestScore = -Infinity;
    for (let i = first; i < words.length - 1; i++) {
      const w = words[i] as Transcript["words"][number];
      const next = words[i + 1] as Transcript["words"][number];
      const cut = (w.end + next.start) / 2;
      if (cut - start < minS) continue;
      if (cut - start > maxS) break;
      if (end - cut < minS) continue;
      const pause = Math.max(0, next.start - w.end);
      const score =
        pause * 2 + (sentenceEnd(w.text) ? 3 : 0) - Math.abs(cut - start - targetS) / targetS;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) {
      // no gap in the window (one very long word run): cut at the limit
      const limit = start + maxS;
      const idx = words.findIndex((w, k) => k >= first && w.end >= limit);
      best = Math.max(first, (idx < 0 ? words.length - 1 : idx) - 1);
    }
    const w = words[best] as Transcript["words"][number];
    const next = words[best + 1] as Transcript["words"][number];
    const cut = +((w.end + next.start) / 2).toFixed(3);
    parts.push({
      startS: start,
      endS: cut,
      text: words
        .slice(first, best + 1)
        .map((x) => x.text)
        .join(" "),
    });
    start = cut;
    first = best + 1;
  }
  parts.push({
    startS: start,
    endS: end,
    text: words
      .slice(first)
      .map((x) => x.text)
      .join(" "),
  });
  return parts;
}

/** The words of [startS, endS) as a transcript of its own, with times from the cut's start. */
export function sliceTranscript(t: Transcript, startS: number, endS: number): Transcript {
  const words = t.words
    .filter((w) => w.start >= startS - 0.01 && w.start < endS)
    .map((w) => ({
      text: w.text,
      start: +Math.max(0, w.start - startS).toFixed(3),
      end: +Math.min(endS - startS, w.end - startS).toFixed(3),
    }));
  return {
    ...t,
    duration_s: +(endS - startS).toFixed(3),
    text: words.map((w) => w.text).join(" "),
    words,
  };
}

/** The last or first few words of a text, for a part's continuity lines. */
export function wordsAround(text: string, n: number, from: "start" | "end"): string {
  const words = text.split(/\s+/).filter(Boolean);
  return (from === "start" ? words.slice(0, n) : words.slice(-n)).join(" ");
}

export interface PlannedParts {
  /** Seconds in the original audio file (the range's offset added). */
  parts: (Part & { transcriptPath: string })[];
  transcriptPath: string;
}

/**
 * Transcribes a long range once, splits it and writes each part's own transcript next to the whole one,
 * so the part jobs skip Whisper and plan from exactly these words.
 */
export async function planParts(o: {
  audioPath: string;
  range?: { startS: number; endS: number } | undefined;
  outDir: string;
  defaults: Defaults;
  language?: string | undefined;
  options?: PartOptions;
  /** The text read aloud (story mode); see align.ts. */
  script?: string | undefined;
  onProgress?: ((message: string) => void) | undefined;
}): Promise<PlannedParts> {
  mkdirSync(o.outDir, { recursive: true });
  let audio = o.audioPath;
  if (o.range) {
    audio = join(o.outDir, "range.wav");
    await cutAudio(o.audioPath, audio, o.range.startS, o.range.endS);
  }
  const heard = await transcribe({
    audioPath: audio,
    defaults: o.defaults,
    language: o.language,
    ...(o.onProgress ? { onProgress: o.onProgress } : {}),
  });
  const transcript = o.script ? correctTranscript(heard, o.script, o.onProgress) : heard;
  const transcriptPath = join(o.outDir, "transcript.json");
  writeFileSync(transcriptPath, JSON.stringify(transcript, null, 2));
  const offset = o.range?.startS ?? 0;
  const parts = splitIntoParts(transcript, o.options).map((p, i) => {
    const file = join(o.outDir, `part-${i + 1}.transcript.json`);
    writeFileSync(file, JSON.stringify(sliceTranscript(transcript, p.startS, p.endS), null, 2));
    return {
      startS: +(p.startS + offset).toFixed(3),
      endS: +(p.endS + offset).toFixed(3),
      text: p.text,
      transcriptPath: file,
    };
  });
  writeFileSync(join(o.outDir, "parts.json"), JSON.stringify({ parts }, null, 2));
  return { parts, transcriptPath };
}

export function readTranscript(file: string): Transcript {
  return TranscriptSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}
