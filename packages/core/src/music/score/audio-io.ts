// packages/core/src/music/score/audio-io.ts
// Music samples in and out: ffmpeg turns whatever Lyria sent into 48 kHz stereo 16-bit, the sfx package reads
// and writes the WAVs; the score is then shaped on Float32 samples.
import { spawnSync } from "node:child_process";
import { decodeWav16, writeWav16 } from "@kilnframe/sfx";
import { ffmpegPath } from "../../config.js";

export const SR = 48_000;

export function readAudio(file: string): Float32Array[] {
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
      "-c:a",
      "pcm_s16le",
      "-f",
      "wav",
      "-",
    ],
    { maxBuffer: 1 << 30 },
  );
  if (r.status !== 0) throw new Error(`Could not read ${file}: ${String(r.stderr)}`);
  return decodeWav16(r.stdout).channels;
}

export function writeAudio(file: string, ch: Float32Array[]): void {
  writeWav16(file, ch, SR);
}
