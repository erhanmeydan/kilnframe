import { spawn } from "node:child_process";
import { ffmpegPath } from "../config.js";

export const WHISPER_SAMPLE_RATE = 16_000;

/** Decodes any audio or video file to mono 32-bit float PCM at the given rate using FFmpeg. */
export function decodeAudio(path: string, sampleRate = WHISPER_SAMPLE_RATE): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const args = [
      "-v",
      "error",
      "-i",
      path,
      "-vn",
      "-ac",
      "1",
      "-ar",
      String(sampleRate),
      "-f",
      "f32le",
      "pipe:1",
    ];
    const proc = spawn(ffmpegPath(), args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    proc.on("error", (err) =>
      reject(new Error(`Could not start FFmpeg (${ffmpegPath()}): ${err.message}`)),
    );
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`FFmpeg could not read the audio file "${path}": ${stderr.trim()}`));
        return;
      }
      const buf = Buffer.concat(chunks);
      const samples = new Float32Array(buf.length / 4);
      for (let i = 0; i < samples.length; i++) samples[i] = buf.readFloatLE(i * 4);
      resolve(samples);
    });
  });
}

/** Cuts [startS, endS) out of an audio file into a 48 kHz WAV (the panel exports the whole sequence audio). */
export function cutAudio(
  input: string,
  output: string,
  startS: number,
  endS: number,
): Promise<void> {
  if (!(endS > startS) || startS < 0) {
    return Promise.reject(new Error(`Invalid range ${startS}-${endS} s.`));
  }
  return new Promise((resolve, reject) => {
    const args = [
      "-v",
      "error",
      "-y",
      "-ss",
      startS.toFixed(6),
      "-i",
      input,
      "-t",
      (endS - startS).toFixed(6),
      "-vn",
      "-ar",
      "48000",
      "-c:a",
      "pcm_s16le",
      output,
    ];
    const proc = spawn(ffmpegPath(), args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    proc.on("error", (err) =>
      reject(new Error(`Could not start FFmpeg (${ffmpegPath()}): ${err.message}`)),
    );
    proc.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`FFmpeg could not cut the audio range: ${stderr.trim()}`)),
    );
  });
}

/** Parses "12.5-42" (seconds) into a range. */
export function parseRange(input: string): { startS: number; endS: number } {
  const m = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(input.trim());
  if (!m) throw new Error(`Invalid range "${input}". Expected seconds like "12.5-42".`);
  const startS = Number(m[1]);
  const endS = Number(m[2]);
  if (!(endS > startS))
    throw new Error(`Invalid range "${input}": the end must be after the start.`);
  return { startS, endS };
}
