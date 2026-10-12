// packages/core/src/music/score/audio-io.ts
// Music samples in and out: ffmpeg turns whatever Lyria sent into 48 kHz stereo 16-bit, the sfx package reads
// writes the WAVs; the score is then shaped on Float32 samples.
import { spawnSync } from "node:child_process";
import { writeWav16 } from "@kilnframe/sfx";
import { ffmpegPath } from "../../config.js";

export const SR = 48_000;

export function readAudio(file: string): Float32Array[] {
  // raw 16-bit samples, not WAV: a WAV written to a pipe has no data length for the reader to go by
  const r = spawnSync(
    ffmpegPath(),
    [
      "-v",
      "error",
      "-i",
      file,
      "-ac",
      "2",
      "-ar",
      String(SR),
      "-f",
      "s16le",
      "-c:a",
      "pcm_s16le",
      "-",
    ],
    { maxBuffer: 1 << 30 },
  );
  if (r.status !== 0) throw new Error(`Could not read ${file}: ${String(r.stderr)}`);
  const pcm = r.stdout;
  const frames = Math.floor(pcm.length / 4);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = pcm.readInt16LE(i * 4) / 32768;
    right[i] = pcm.readInt16LE(i * 4 + 2) / 32768;
  }
  return [left, right];
}

export function writeAudio(file: string, ch: Float32Array[]): void {
  writeWav16(file, ch, SR);
}
