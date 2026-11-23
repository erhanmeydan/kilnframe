import { fork, type ChildProcess } from "node:child_process";
import { closeSync, fstatSync, mkdtempSync, openSync, readSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Defaults } from "../config.js";
import { modelsDir } from "../config.js";
import { WHISPER_SAMPLE_RATE, decodeAudio } from "../media/audio.js";
import { TranscriptSchema, type Transcript, type Word } from "../schemas/transcript.js";
import {
  joinParts,
  partsProgress,
  planParts,
  speechProcesses,
  languageWindows,
  speechThreads,
  voteLanguage,
  type Machine,
  type Part,
  type PartOptions,
} from "./transcribe-parts.js";
import { removeTempDir } from "../temp-dir.js";

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
    // never before the word ahead of it; the end moves with the start, or the schema refuses the transcript
    const at = prev ? Math.max(start, prev.start) : start;
    words.push({ text, start: at, end: Math.max(end, at) });
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

export type AsrPipeline = ((
  audio: Float32Array,
  options: Record<string, unknown>,
) => Promise<unknown>) & {
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

/** Every language's probability over the language tokens of one decoding step (`<|tr|>` -> "tr"). */
export function languageProbabilities(
  scores: [token: string, logit: number][],
): Record<string, number> {
  const top = Math.max(...scores.map(([, v]) => v));
  const z = scores.reduce((sum, [, v]) => sum + Math.exp(v - top), 0);
  return Object.fromEntries(
    scores.map(([token, v]) => [token.replace(/^<\|(.+)\|>$/, "$1"), Math.exp(v - top) / z]),
  );
}

/**
 * The spoken language's probabilities the way Whisper tells them: one decoding step on 30 seconds, then
 * the language tokens. transformers.js has no detection of its own and silently assumes English, which
 * turns Turkish speech into invented English sentences.
 */
export async function languageScores(asr: AsrPipeline, audio: Float32Array) {
  const { Tensor } = await import("@huggingface/transformers");
  const gc = asr.model.generation_config;
  const inputs = await asr.processor(audio.slice(0, 30 * WHISPER_SAMPLE_RATE));
  const out = await asr.model({
    ...inputs,
    decoder_input_ids: new Tensor("int64", [BigInt(gc.decoder_start_token_id)], [1, 1]),
  });
  const logits = out.logits.data;
  return languageProbabilities(
    Object.entries(gc.lang_to_id).map(([token, id]) => [token, Number(logits[id])]),
  );
}

/** The spoken language from 30 seconds at each of the given samples (languageWindows), by vote. */
export async function detectLanguage(
  asr: AsrPipeline,
  audio: Float32Array,
  starts: number[] = [0],
) {
  const windows = [];
  for (const start of starts)
    windows.push(
      await languageScores(asr, audio.subarray(start, start + 30 * WHISPER_SAMPLE_RATE)),
    );
  return voteLanguage(windows);
}

/**
 * Loads the speech model, downloading it on first use (about 1 GB) with progress messages.
 * The companion calls this during onboarding so the first job does not wait for the download.
 */
export async function loadSpeechModel(
  defaults: Defaults,
  onProgress?: (message: string) => void,
  /** Threads for the model; several processes reading at once each get their share (speechThreads). */
  threads?: number,
): Promise<AsrPipeline> {
  const { model, dtype } = defaults.whisper;
  const { env, pipeline } = await import("@huggingface/transformers");
  env.cacheDir = modelsDir();
  try {
    const asr = await pipeline("automatic-speech-recognition", model, {
      dtype: dtype as never,
      progress_callback: downloadProgress((p) => onProgress?.(`Downloading speech model: ${p}%`)),
      ...(threads ? { session_options: { intraOpNumThreads: threads } } : {}),
    });
    return asr as unknown as AsrPipeline;
  } catch (err) {
    throw downloadError(err);
  }
}

/**
 * The first use downloads the model; Node's own "fetch failed", or "terminated" when the connection drops
 * halfway through a file, says nothing an editor can act on. Other errors come back as they are.
 */
export function downloadError(err: unknown): unknown {
  const cause = (err as { cause?: { code?: string } } | undefined)?.cause?.code;
  if (
    err instanceof Error &&
    /fetch failed|terminated|ENOTFOUND|ECONNRESET|ETIMEDOUT|UND_ERR_SOCKET/i.test(
      `${err.message} ${cause ?? ""}`,
    )
  )
    return new Error(
      `Could not download the speech model (${cause ?? err.message}). Check the internet connection and try again.`,
      { cause: err },
    );
  return err;
}

export interface TranscribeOptions {
  audioPath: string;
  defaults: Defaults;
  /** Force a language code such as "tr"; auto-detect when omitted. */
  language?: string | undefined;
  onProgress?: (message: string) => void;
}

/** What the speech process is asked to do (speech-worker.ts). */
export type SpeechModelRequest =
  | { kind: "transcribe"; audioPath: string; defaults: Defaults; language?: string | undefined }
  | { kind: "download"; defaults: Defaults }
  | SpeechPartsRequest;

export type SpeechModelReply =
  | { type: "progress"; message: string }
  | { type: "done"; transcript?: Transcript }
  | { type: "failed"; name: string; message: string };

/**
 * A speech process that reads parts (runSpeechParts): it loads the model, says "ready", then answers
 * "detect" with the language and each "piece" with Whisper's word chunks, until "end".
 */
export interface SpeechPartsRequest {
  kind: "parts";
  defaults: Defaults;
  threads?: number | undefined;
  /** The whole recording as 32-bit float samples (little endian), written once by the coordinator. */
  pcmPath: string;
  sampleRate: number;
}

export type SpeechPartsMessage =
  | { type: "detect"; starts: number[] }
  | { type: "piece"; index: number; start: number; end: number; language: string }
  | { type: "end" };

export type SpeechPartsReply =
  | { type: "progress"; message: string }
  | { type: "ready" }
  | { type: "language"; language: string; probability: number }
  | { type: "piece"; index: number; chunks: AsrChunk[] }
  | { type: "failed"; name: string; message: string };

/** Reads samples [start, end) of a recording written as 32-bit floats. */
export function readSamples(pcmPath: string, start: number, end: number): Float32Array {
  const fd = openSync(pcmPath, "r");
  // never past the end of the recording: 30 seconds of language from a short one are what it has
  const out = new Float32Array(Math.max(0, Math.min(end, fstatSync(fd).size / 4) - start));
  try {
    readSync(fd, new Uint8Array(out.buffer), 0, out.byteLength, start * 4);
  } finally {
    closeSync(fd);
  }
  return out;
}

/** Whisper's words for one piece of audio, with the options a whole recording was always read with. */
export async function recognize(
  asr: AsrPipeline,
  audio: Float32Array,
  defaults: Defaults,
  language: string,
): Promise<AsrChunk[]> {
  const output = (await asr(audio, {
    return_timestamps: "word",
    chunk_length_s: defaults.whisper.chunkLengthS,
    language,
    task: "transcribe",
  })) as { text: string; chunks?: AsrChunk[] };
  return output.chunks ?? [];
}

const SPEECH_WORKER = fileURLToPath(new URL("./speech-worker.js", import.meta.url));

/** The words of a speech process that stopped without saying why. */
const STOPPED = (code: number | null) =>
  `The speech model stopped unexpectedly (exit ${code ?? "signal"}). If the computer is low on memory, close other programs and try again.`;

/**
 * Runs the speech model in a process of its own. The model takes about 4 GB while it works and the memory
 * it leaves behind (over 1.5 GB) does not go back to the system until the process ends; in the job process
 * that memory stayed taken while Chrome rendered, and on a computer with 8 GB that pushes Premiere into swap.
 */
export function runSpeechProcess(
  request: SpeechModelRequest,
  onProgress?: (message: string) => void,
  workerPath = SPEECH_WORKER,
): Promise<Transcript | undefined> {
  return new Promise((resolve, reject) => {
    // same process group as the caller, so stopping a job also ends this process
    const child = fork(workerPath, [], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    child.on("message", (m: SpeechModelReply) => {
      if (m.type === "progress") onProgress?.(m.message);
      else if (m.type === "done") finish(() => resolve(m.transcript));
      else
        finish(() =>
          reject(m.name === "NoSpeechError" ? new NoSpeechError() : new Error(m.message)),
        );
    });
    // close, not exit: it comes after the IPC channel has delivered the last message
    child.on("close", (code) => finish(() => reject(new Error(STOPPED(code)))));
    child.on("error", (err) => finish(() => reject(err)));
    child.send(request);
  });
}

/** Downloads the speech model without keeping it in this process's memory (the companion runs all day). */
export async function downloadSpeechModel(
  defaults: Defaults,
  onProgress?: (message: string) => void,
): Promise<void> {
  await runSpeechProcess({ kind: "download", defaults }, onProgress);
}

export interface SpeechPartsOptions extends TranscribeOptions {
  /** Stops every speech process (the job is stopped otherwise by ending its whole process tree). */
  signal?: AbortSignal | undefined;
  /** This computer, for how many processes read at once (speechProcesses). */
  machine?: Machine | undefined;
  /** At most this many processes, whatever the computer allows. */
  maxProcesses?: number | undefined;
  partOptions?: PartOptions | undefined;
  workerPath?: string | undefined;
}

/**
 * Transcribes in processes of their own; the memory is free again when it returns. A long recording is cut
 * in quiet moments into parts of about two minutes, and as many processes as the computer can spare beside
 * the editor read them at once, each its own model. A short one is one part, read as it always was.
 */
export async function transcribe(options: SpeechPartsOptions): Promise<Transcript> {
  const { audioPath, defaults, onProgress } = options;
  const { model } = defaults.whisper;

  onProgress?.("Decoding audio");
  let audio: Float32Array | undefined = await decodeAudio(audioPath);
  const durationS = audio.length / WHISPER_SAMPLE_RATE;
  // nothing to hear in the range (a range past the end of the sound): said as no speech, not as a file error
  if (durationS < 0.1) throw new NoSpeechError();

  const parts = planParts(audio, WHISPER_SAMPLE_RATE, options.partOptions);
  const detectAt = languageWindows(audio, WHISPER_SAMPLE_RATE);
  const machine = options.machine ?? {
    totalMemoryBytes: totalmem(),
    cores: availableParallelism(),
  };
  const processes = Math.max(
    1,
    Math.min(speechProcesses(machine, durationS), parts.length, options.maxProcesses ?? Infinity),
  );
  const dir = mkdtempSync(join(tmpdir(), "kf-speech-"));
  try {
    const pcmPath = join(dir, "audio.f32");
    writeFileSync(pcmPath, new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength));
    audio = undefined;
    onProgress?.(`Loading speech model ${model}`);
    const { language, chunks } = await runSpeechParts({
      ...options,
      request: {
        kind: "parts",
        defaults,
        threads: speechThreads(machine, processes),
        pcmPath,
        sampleRate: WHISPER_SAMPLE_RATE,
      },
      parts,
      processes,
      detectAt,
    });
    const words = joinParts(parts, chunks, WHISPER_SAMPLE_RATE);
    if (words.length === 0) throw new NoSpeechError();
    return TranscriptSchema.parse({
      version: 1,
      language,
      model,
      duration_s: durationS,
      // from the cleaned words, so text and words agree after seams and invented words are removed
      text: words.map((w) => w.text).join(" "),
      words,
    });
  } finally {
    removeTempDir(dir);
  }
}

/**
 * Runs `processes` speech processes over the parts. The first loads the model (downloading it the first
 * time, alone) and tells the language from the first 30 seconds; then the others start, and each takes the
 * next part as soon as it is free. Any process failing, or the signal, ends them all.
 */
export function runSpeechParts(o: {
  request: SpeechPartsRequest;
  parts: Part[];
  processes: number;
  language?: string | undefined;
  /** Where the 30-second windows the language is told from begin, in samples (languageWindows). */
  detectAt?: number[] | undefined;
  onProgress?: ((message: string) => void) | undefined;
  signal?: AbortSignal | undefined;
  workerPath?: string | undefined;
}): Promise<{ language: string; chunks: AsrChunk[][] }> {
  const { request, parts, processes, onProgress, signal } = o;
  const workerPath = o.workerPath ?? SPEECH_WORKER;
  const totalSamples = parts.reduce((sum, p) => sum + p.end - p.start, 0);
  const chunks: AsrChunk[][] = parts.map(() => []);
  const report = partsProgress((p) => onProgress?.(`Transcribing: ${p}%`));

  return new Promise((resolve, reject) => {
    interface Reader {
      child: ChildProcess;
      ready: boolean;
      busy: boolean;
    }
    const readers: Reader[] = [];
    let language = o.language;
    let next = 0;
    let done = 0;
    let doneSamples = 0;
    let settled = false;

    const end = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const fail = (err: Error) =>
      end(() => {
        for (const r of readers) r.child.kill();
        reject(err);
      });
    const onAbort = () =>
      fail(
        signal?.reason instanceof Error ? signal.reason : new Error("Transcription was stopped."),
      );
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort);

    const take = (r: Reader) => {
      if (settled || !r.ready || r.busy || language === undefined || next >= parts.length) return;
      const index = next++;
      const part = parts[index] as Part;
      r.busy = true;
      r.child.send({ type: "piece", index, start: part.start, end: part.end, language });
    };

    const start = (first: boolean) => {
      // same process group as the caller, so stopping a job also ends these processes
      const child = fork(workerPath, [], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
      const reader: Reader = { child, ready: false, busy: false };
      readers.push(reader);
      child.on("message", (m: SpeechPartsReply) => {
        if (settled) return;
        if (m.type === "progress") {
          // the download and loading lines once, from the first process
          if (first) onProgress?.(m.message);
        } else if (m.type === "ready") {
          reader.ready = true;
          if (first) {
            if (language === undefined) {
              onProgress?.("Detecting language");
              child.send({ type: "detect", starts: o.detectAt ?? [0] });
            } else onProgress?.("Transcribing");
            // the model is on disk now: the others load it without downloading it again
            for (let k = 1; k < processes; k++) start(false);
          }
          take(reader);
        } else if (m.type === "language") {
          language = m.language;
          onProgress?.(`Language: ${language} (${Math.round(m.probability * 100)}%)`);
          onProgress?.("Transcribing");
          for (const r of readers) take(r);
        } else if (m.type === "piece") {
          chunks[m.index] = m.chunks;
          done++;
          const part = parts[m.index] as Part;
          doneSamples += part.end - part.start;
          report(doneSamples, totalSamples);
          reader.busy = false;
          if (done === parts.length)
            end(() => {
              for (const r of readers) r.child.send({ type: "end" });
              resolve({ language: language ?? "", chunks });
            });
          else take(reader);
        } else if (m.type === "failed") {
          fail(m.name === "NoSpeechError" ? new NoSpeechError() : new Error(m.message));
        }
      });
      // close, not exit: it comes after the IPC channel has delivered the last message
      child.on("close", (code) => fail(new Error(STOPPED(code))));
      child.on("error", (err) => fail(err));
      child.send(request);
    };
    start(true);
  });
}

/** Transcribes in this process; the speech process (speech-worker.ts) calls it. */
export async function transcribeHere(options: TranscribeOptions): Promise<Transcript> {
  const { audioPath, defaults, language, onProgress } = options;
  const { model } = defaults.whisper;

  onProgress?.("Decoding audio");
  const audio = await decodeAudio(audioPath);
  const durationS = audio.length / WHISPER_SAMPLE_RATE;
  // nothing to hear in the range (a range past the end of the sound): said as no speech, not as a file error
  if (durationS < 0.1) throw new NoSpeechError();

  onProgress?.(`Loading speech model ${model}`);
  const asr = await loadSpeechModel(defaults, onProgress);

  let spoken = language;
  if (!spoken) {
    onProgress?.("Detecting language");
    const detected = await detectLanguage(asr, audio, languageWindows(audio, WHISPER_SAMPLE_RATE));
    spoken = detected.language;
    onProgress?.(`Language: ${spoken} (${Math.round(detected.probability * 100)}%)`);
  }

  onProgress?.("Transcribing");
  const words = chunksToWords(await recognize(asr, audio, defaults, spoken), durationS);
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
