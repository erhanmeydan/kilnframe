/**
 * Where a recording holds speech, read as a stream: FFmpeg decodes the sound and the voice model scores it
 * 512 samples at a time as it arrives, so only the probabilities stay in memory (a 2 hour timeline decoded
 * whole would be 460 MB of samples).
 */
import { spawn } from "node:child_process";
import { ffmpegPath } from "../config.js";
import {
  VAD_FRAME,
  VAD_SAMPLE_RATE,
  openVad,
  speechFromProbabilities,
  type VadStream,
} from "./vad.js";

/**
 * FFmpeg's afftdn hands its sound back 25 ms late (measured with FFmpeg 9.0 at 16, 44.1 and 48 kHz): left
 * in, every cut would end 25 ms into the next word.
 */
export const DENOISE_DELAY_S = 0.025;

export interface FindSpeechOptions {
  audioPath: string;
  /** The part of `audioPath` to listen to (Premiere exports the whole sequence). */
  rangeStartS?: number | undefined;
  rangeEndS?: number | undefined;
  model: string;
  signal?: AbortSignal;
  /** 0..1 of the audio listened to. */
  onProgress?: (done: number) => void;
  /** Tests: the frame scorer instead of the model. */
  vad?: VadStream;
}

/** Speech stretches in seconds from the range start, and the length of the sound read. */
export async function findSpeech(
  o: FindSpeechOptions,
): Promise<{ speech: [number, number][]; durationS: number }> {
  o.signal?.throwIfAborted();
  const vad = o.vad ?? (await openVad(o.model));
  o.signal?.throwIfAborted();
  const start = o.rangeStartS ?? 0;
  const args = ["-hide_banner", "-nostats", "-nostdin"];
  if (start > 0) args.push("-ss", start.toFixed(6));
  args.push("-i", o.audioPath);
  if (o.rangeEndS !== undefined) args.push("-t", Math.max(0, o.rangeEndS - start).toFixed(6));
  // a high pass and a light denoise make the voice easier for the model to tell from room sound
  args.push(
    ...["-vn", "-af", "highpass=f=70,afftdn=nf=-45", "-ac", "1", "-ar", String(VAD_SAMPLE_RATE)],
    ...["-f", "f32le", "pipe:1"],
  );

  const proc = spawn(ffmpegPath(), args, { stdio: ["ignore", "pipe", "pipe"] });
  // only the tail is kept: an error message, and the Duration line for the progress
  let stderr = "";
  let totalS = o.rangeEndS !== undefined ? o.rangeEndS - start : 0;
  proc.stderr.on("data", (c: Buffer) => {
    stderr = (stderr + c.toString()).slice(-8192);
    if (!totalS) {
      const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
      if (m) totalS = Math.max(0, +m[1]! * 3600 + +m[2]! * 60 + +m[3]! - start);
    }
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    proc.on("error", (err) =>
      reject(new Error(`Could not start FFmpeg (${ffmpegPath()}): ${err.message}`)),
    );
    proc.on("close", (code) => resolve(code));
  });
  exited.catch(() => undefined);
  const kill = () => proc.kill("SIGKILL");
  o.signal?.addEventListener("abort", kill, { once: true });

  // probabilities grow in blocks, one float per 32 ms frame (a 2 hour timeline is under 1 MB)
  let probs = new Float32Array(4096);
  let frames = 0;
  let samples = 0;
  let lastProgress = -1;
  const frame = new Float32Array(VAD_FRAME);
  let filled = 0;
  let carry = Buffer.alloc(0);
  const score = async (f: Float32Array) => {
    if (frames === probs.length) {
      const grown = new Float32Array(probs.length * 2);
      grown.set(probs);
      probs = grown;
    }
    probs[frames++] = await vad.push(f);
  };

  try {
    // iterating the stream pauses FFmpeg while the model works, so at most one chunk is held
    for await (const chunk of proc.stdout as AsyncIterable<Buffer>) {
      o.signal?.throwIfAborted();
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const whole = buf.length - (buf.length % 4);
      for (let i = 0; i < whole; i += 4) {
        frame[filled++] = buf.readFloatLE(i);
        if (filled === VAD_FRAME) {
          await score(frame);
          filled = 0;
        }
      }
      carry = Buffer.from(buf.subarray(whole));
      samples += whole / 4;
      if (o.onProgress && totalS > 0) {
        const done = Math.min(0.99, samples / VAD_SAMPLE_RATE / totalS);
        if (done - lastProgress >= 0.01) {
          lastProgress = done;
          o.onProgress(done);
        }
      }
    }
    o.signal?.throwIfAborted();
    const code = await exited;
    o.signal?.throwIfAborted();
    if (code !== 0)
      throw new Error(`FFmpeg could not read the audio file "${o.audioPath}": ${stderr.trim()}`);
    if (filled > 0) await score(frame.subarray(0, filled));
  } catch (err) {
    kill();
    throw err;
  } finally {
    o.signal?.removeEventListener("abort", kill);
  }
  o.onProgress?.(1);
  const durationS = samples / VAD_SAMPLE_RATE;
  // back by the denoiser's delay; a padded last frame counts as whole, so its speech ends with the sound
  const end = +durationS.toFixed(3);
  const speech = speechFromProbabilities(probs.subarray(0, frames))
    .map(([a, b]): [number, number] => [
      Math.max(0, +(a - DENOISE_DELAY_S).toFixed(3)),
      Math.min(end, +(b - DENOISE_DELAY_S).toFixed(3)),
    ])
    .filter(([a, b]) => b > a);
  return { speech, durationS };
}
