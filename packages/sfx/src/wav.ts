import { writeFileSync } from "node:fs";
import { SAMPLE_RATE } from "./constants.js";

/** Encodes channels as a 16-bit PCM WAV buffer. Samples are clipped to [-1, 1]. */
export function encodeWav16(channels: Float32Array[], sampleRate = SAMPLE_RATE): Buffer {
  const ch = channels.length;
  const n = channels[0]?.length ?? 0;
  const dataBytes = n * ch * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(ch, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * ch * 2, 28);
  buf.writeUInt16LE(ch * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, channels[c]?.[i] ?? 0));
      buf.writeInt16LE(Math.round(v * 32767), o);
      o += 2;
    }
  }
  return buf;
}

export function writeWav16(path: string, channels: Float32Array[], sampleRate = SAMPLE_RATE): void {
  writeFileSync(path, encodeWav16(channels, sampleRate));
}

/** Reads back a 16-bit PCM WAV written by `encodeWav16` (used in tests and checks). */
export function decodeWav16(buf: Buffer): { sampleRate: number; channels: Float32Array[] } {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE")
    throw new Error("not a WAV file");
  const ch = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  if (bits !== 16) throw new Error(`expected 16-bit PCM, got ${bits}`);
  const dataBytes = buf.readUInt32LE(40);
  const n = dataBytes / (2 * ch);
  const channels = Array.from({ length: ch }, () => new Float32Array(n));
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      (channels[c] as Float32Array)[i] = buf.readInt16LE(o) / 32767;
      o += 2;
    }
  }
  return { sampleRate, channels };
}
