import type { Defaults } from "../config.js";
import { modelsDir } from "../config.js";
import { WHISPER_SAMPLE_RATE, decodeAudio } from "../media/audio.js";
import { TranscriptSchema, type Transcript, type Word } from "../schemas/transcript.js";

/** A word chunk as returned by the transformers.js ASR pipeline with `return_timestamps: "word"`. */
export interface AsrChunk {
  text: string;
  timestamp: [number, number | null];
}

/**
 * Turns pipeline chunks into clean, time-ordered words. New words arrive with a leading space;
 * a chunk without one continues the previous word (Turkish suffixes such as "Prompt" + "'a").
 * Whisper sometimes leaves the last end time open or returns tokens that are only spaces; both are
 * repaired here. Words that start after the audio ends cannot have been spoken: Whisper invents them on
 * music or silence (in Turkish typically "Altyazı M.K."), so they are dropped.
 */
export function chunksToWords(chunks: AsrChunk[], durationS: number): Word[] {
  const words: Word[] = [];
  chunks.forEach((chunk, i) => {
    const text = chunk.text.trim();
    if (!text) return;
    if (chunk.timestamp[0] >= durationS) return;
    const start = Math.max(0, chunk.timestamp[0]);
    // Audio over 30 s is read in overlapping windows; at a window seam Whisper can repeat the overlap
    // and time jumps back by seconds. Drop the earlier copy and keep the later window, which saw more
    // context.
    if (
      /^\s/.test(chunk.text) &&
      words.length &&
      start < (words[words.length - 1]?.start ?? 0) - 0.5
    ) {
      while (words.length && (words[words.length - 1]?.start ?? 0) >= start - 0.05) words.pop();
    }
    const nextStart = chunks[i + 1]?.timestamp[0];
    let end = chunk.timestamp[1] ?? nextStart ?? durationS;
    end = Math.min(Math.max(end, start), durationS);
    const prev = words[words.length - 1];
    if (prev && !/^\s/.test(chunk.text)) {
      prev.text += text;
      prev.end = Math.max(prev.end, end);
      return;
    }
    words.push({ text, start: prev ? Math.max(start, prev.start) : start, end });
  });
  return words;
}

/** The audio holds no speech, so there is nothing to animate. */
export class NoSpeechError extends Error {
  constructor() {
    super("No speech was found in this audio. Pick a range where someone is talking.");
    this.name = "NoSpeechError";
  }
}

/** Turns per-file download events into one overall percentage, reported in 5 percent steps. */
export function downloadProgress(report: (percent: number) => void): (event: unknown) => void {
  const files = new Map<string, { loaded: number; total: number }>();
  let last = -1;
  return (event) => {
    const e = event as { status?: string; file?: string; loaded?: number; total?: number };
    if (e.status !== "progress" || !e.file || !e.total) return;
    files.set(e.file, { loaded: e.loaded ?? 0, total: e.total });
    let loaded = 0;
    let total = 0;
    for (const f of files.values()) {
      loaded += f.loaded;
      total += f.total;
    }
    const percent = Math.floor((loaded / total) * 100);
    const step = Math.floor(percent / 5) * 5;
    if (step > last) {
      last = step;
      report(step);
    }
  };
}

type AsrPipeline = ((audio: Float32Array, options: Record<string, unknown>) => Promise<unknown>) & {
  processor: (audio: Float32Array) => Promise<Record<string, unknown>>;
  model: ((inputs: Record<string, unknown>) => Promise<{ logits: { data: ArrayLike<number> } }>) & {
    generation_config: { decoder_start_token_id: number; lang_to_id: Record<string, number> };
  };
};

/** Picks the most likely language from scores over the language tokens (`<|tr|>` -> "tr"). */
export function pickLanguage(scores: [token: string, logit: number][]): {
  language: string;
  probability: number;
} {
  const sorted = [...scores].sort((a, b) => b[1] - a[1]);
  const [top] = sorted;
  if (!top) throw new Error("The speech model has no language tokens.");
  const z = sorted.reduce((sum, [, v]) => sum + Math.exp(v - top[1]), 0);
  return { language: top[0].replace(/^<\|(.+)\|>$/, "$1"), probability: 1 / z };
}

/**
 * Detects the spoken language the way Whisper does: one decoding step on the first 30 seconds, then the
 * most likely language token. transformers.js has no detection of its own and silently assumes English,
 * which turns Turkish speech into invented English sentences.
 */
export async function detectLanguage(asr: AsrPipeline, audio: Float32Array) {
  const { Tensor } = await import("@huggingface/transformers");
  const gc = asr.model.generation_config;
  const inputs = await asr.processor(audio.slice(0, 30 * WHISPER_SAMPLE_RATE));
  const out = await asr.model({
    ...inputs,
    decoder_input_ids: new Tensor("int64", [BigInt(gc.decoder_start_token_id)], [1, 1]),
  });
  const logits = out.logits.data;
  return pickLanguage(
    Object.entries(gc.lang_to_id).map(([token, id]) => [token, Number(logits[id])]),
  );
}

/**
 * Loads the speech model, downloading it on first use (about 1 GB) with progress messages.
 * The companion calls this during onboarding so the first job does not wait for the download.
 */
export async function loadSpeechModel(
  defaults: Defaults,
  onProgress?: (message: string) => void,
): Promise<AsrPipeline> {
  const { model, dtype } = defaults.whisper;
  const { env, pipeline } = await import("@huggingface/transformers");
  env.cacheDir = modelsDir();
  try {
    const asr = await pipeline("automatic-speech-recognition", model, {
      dtype: dtype as never,
      progress_callback: downloadProgress((p) => onProgress?.(`Downloading speech model: ${p}%`)),
    });
    return asr as unknown as AsrPipeline;
  } catch (err) {
    // the first use downloads the model; Node's own "fetch failed" says nothing an editor can act on
    const cause = (err as { cause?: { code?: string } }).cause?.code;
    if (
      err instanceof Error &&
      /fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT/i.test(`${err.message} ${cause ?? ""}`)
    )
      throw new Error(
        `Could not download the speech model (${cause ?? err.message}). Check the internet connection and try again.`,
        { cause: err },
      );
    throw err;
  }
}

export interface TranscribeOptions {
  audioPath: string;
  defaults: Defaults;
  /** Force a language code such as "tr"; auto-detect when omitted. */
  language?: string | undefined;
  onProgress?: (message: string) => void;
}

export async function transcribe(options: TranscribeOptions): Promise<Transcript> {
  const { audioPath, defaults, language, onProgress } = options;
  const { model, chunkLengthS } = defaults.whisper;

  onProgress?.("Decoding audio");
  const audio = await decodeAudio(audioPath);
  const durationS = audio.length / WHISPER_SAMPLE_RATE;
  if (durationS < 0.1) throw new Error(`The audio file "${audioPath}" is empty.`);

  onProgress?.(`Loading speech model ${model}`);
  const asr = await loadSpeechModel(defaults, onProgress);

  let spoken = language;
  if (!spoken) {
    onProgress?.("Detecting language");
    const detected = await detectLanguage(asr, audio);
    spoken = detected.language;
    onProgress?.(`Language: ${spoken} (${Math.round(detected.probability * 100)}%)`);
  }

  onProgress?.("Transcribing");
  const output = (await asr(audio, {
    return_timestamps: "word",
    chunk_length_s: chunkLengthS,
    language: spoken,
    task: "transcribe",
  })) as { text: string; chunks?: AsrChunk[] };

  const words = chunksToWords(output.chunks ?? [], durationS);
  if (words.length === 0) throw new NoSpeechError();
  return TranscriptSchema.parse({
    version: 1,
    language: spoken,
    model,
    duration_s: durationS,
    // from the cleaned words, so text and words agree after seams and invented words are removed
    text: words.map((w) => w.text).join(" "),
    words,
  });
}
