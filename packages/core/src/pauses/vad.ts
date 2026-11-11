/**
 * Where a recording holds speech, from Silero VAD (a 2 MB voice activity model, run locally): far steadier
 * than Whisper's word times, which stretch a word over the pause after it, and than a loudness threshold,
 * which takes a soft last word for silence. Trained on phone and far-field sound as well as microphones, so a
 * camera's own sound or a phone's works as a clip-on microphone does. No transcript is needed, so it is quick
 * and works in any language.
 */
import type { Tensor } from "@huggingface/transformers";
import { modelsDir } from "../config.js";
import { downloadError, downloadProgress } from "../stages/transcribe.js";

export const VAD_SAMPLE_RATE = 16000;
/** The model reads 512 samples at 16 kHz (32 ms), with the 64 before them as context. */
export const VAD_FRAME = 512;
export const VAD_FRAME_S = VAD_FRAME / VAD_SAMPLE_RATE;
const CONTEXT = 64;

export interface VadOptions {
  /** Speech begins where the probability reaches this. */
  threshold?: number;
  /** And ends where it falls below this (hysteresis, so a soft syllable does not split a word). */
  release?: number;
  /** Speech shorter than this is a click or a breath, not speech. */
  minSpeechS?: number;
  /** A pause shorter than this is inside the speech. */
  minSilenceS?: number;
}

/** The loaded model: one frame with its context, the sample rate and the previous state in. */
export type VadModel = (args: {
  input: Tensor;
  sr: Tensor;
  state: Tensor;
}) => Promise<{ output: Tensor; stateN: Tensor }>;

/** One frame at a time: keeps the model's state and the 64 samples of context between calls. */
export interface VadStream {
  /** The speech probability of up to 512 samples of 16 kHz mono audio (a shorter last frame is padded). */
  push(frame: Float32Array): Promise<number>;
}

const loading = new Map<string, Promise<VadModel>>();

async function fromPretrained(model: string, onProgress?: (message: string) => void) {
  const { AutoModel, env } = await import("@huggingface/transformers");
  env.cacheDir = modelsDir();
  return AutoModel.from_pretrained(model, {
    // the repo's config names no architecture transformers knows; the ONNX file is run as it is
    config: { model_type: "custom" } as never,
    dtype: "fp32",
    ...(onProgress && {
      progress_callback: downloadProgress((p) => onProgress(`Downloading voice model: ${p}%`)),
    }),
  });
}

/** The model, loaded once per process (downloaded into modelsDir() on first use). */
function loadVad(model: string): Promise<VadModel> {
  let p = loading.get(model);
  if (!p) {
    p = fromPretrained(model).then(
      (m) => m as unknown as VadModel,
      (err: unknown) => {
        loading.delete(model);
        throw downloadError(err);
      },
    );
    loading.set(model, p);
  }
  return p;
}

/**
 * A stream over the model: frames are pushed as they are decoded, so a long timeline never sits in memory.
 * The model is recurrent and needs only its previous state and the last 64 samples.
 */
export async function openVad(
  model: string,
  /** Tests: a stand-in for the model. */
  load: (model: string) => Promise<VadModel> = loadVad,
): Promise<VadStream> {
  const run = await load(model);
  const { Tensor } = await import("@huggingface/transformers");
  const sr = new Tensor("int64", [BigInt(VAD_SAMPLE_RATE)], []);
  let state = new Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
  let context = new Float32Array(CONTEXT);
  return {
    async push(frame) {
      if (frame.length > VAD_FRAME)
        throw new Error(`A voice model frame holds at most ${VAD_FRAME} samples.`);
      const chunk = new Float32Array(CONTEXT + VAD_FRAME);
      chunk.set(context, 0);
      chunk.set(frame, CONTEXT);
      context = chunk.slice(chunk.length - CONTEXT);
      const r = await run({
        input: new Tensor("float32", chunk, [1, CONTEXT + VAD_FRAME]),
        sr,
        state,
      });
      state = r.stateN;
      return (r.output.data as Float32Array)[0] as number;
    },
  };
}

/** Speech stretches (seconds) from frame probabilities, joined over short pauses, short blips dropped. */
export function speechFromProbabilities(
  probs: Float32Array,
  o: VadOptions = {},
): [number, number][] {
  const on = o.threshold ?? 0.5;
  const off = o.release ?? 0.35;
  const minSpeech = o.minSpeechS ?? 0.12;
  const minSilence = o.minSilenceS ?? 0.1;
  const raw: [number, number][] = [];
  let start = -1;
  for (let f = 0; f < probs.length; f++) {
    const p = probs[f] as number;
    if (start < 0 && p >= on) start = f;
    else if (start >= 0 && p < off) {
      raw.push([start * VAD_FRAME_S, f * VAD_FRAME_S]);
      start = -1;
    }
  }
  if (start >= 0) raw.push([start * VAD_FRAME_S, probs.length * VAD_FRAME_S]);
  const joined: [number, number][] = [];
  for (const [a, b] of raw) {
    const last = joined.at(-1);
    if (last && a - last[1] < minSilence) last[1] = b;
    else joined.push([a, b]);
  }
  return joined
    .filter(([a, b]) => b - a >= minSpeech)
    .map(([a, b]) => [+a.toFixed(3), +b.toFixed(3)]);
}

/** Speech stretches of 16 kHz mono audio held in memory (whole frames only). */
export async function vadSpeechSpans(
  audio: Float32Array,
  model: string,
  o: VadOptions & { signal?: AbortSignal } = {},
): Promise<[number, number][]> {
  const vad = await openVad(model);
  const frames = Math.floor(audio.length / VAD_FRAME);
  const probs = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    if (f % 2000 === 0) o.signal?.throwIfAborted();
    probs[f] = await vad.push(audio.subarray(f * VAD_FRAME, (f + 1) * VAD_FRAME));
  }
  return speechFromProbabilities(probs, o);
}

/** The pauses between speech stretches (and before the first, after the last), as quiet stretches. */
export function pausesBetween(speech: [number, number][], durationS: number): [number, number][] {
  const out: [number, number][] = [];
  let at = 0;
  for (const [a, b] of speech) {
    if (a > at) out.push([at, a]);
    at = Math.max(at, b);
  }
  if (durationS > at) out.push([at, durationS]);
  return out;
}

/**
 * Fetches the model into modelsDir() when missing (about 2 MB), with progress messages. The companion
 * calls this with the other models so the first Remove Pauses job does not wait for it.
 */
export async function downloadVadModel(
  model: string,
  onProgress?: (message: string) => void,
): Promise<void> {
  try {
    await fromPretrained(model, onProgress);
  } catch (err) {
    throw downloadError(err);
  }
}
