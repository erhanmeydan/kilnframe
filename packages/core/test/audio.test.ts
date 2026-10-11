import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  WHISPER_SAMPLE_RATE,
  cutAudio,
  decodeAudio,
  ffmpegPath,
  listStyles,
  stylesDir,
  parseRange,
} from "../src/index.js";

function hasFfmpeg(): boolean {
  try {
    execFileSync(ffmpegPath(), ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasFfmpeg())("decodeAudio", () => {
  it("decodes a stereo 48 kHz WAV to mono 16 kHz floats", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mi-audio-"));
    const wav = join(dir, "tone.wav");
    execFileSync(ffmpegPath(), [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1.5:sample_rate=48000",
      "-ac",
      "2",
      wav,
    ]);
    const samples = await decodeAudio(wav);
    expect(samples.length).toBeGreaterThan(WHISPER_SAMPLE_RATE * 1.49);
    expect(samples.length).toBeLessThan(WHISPER_SAMPLE_RATE * 1.51);
    const peak = samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(peak).toBeGreaterThan(0.05);
  });

  it("cuts a range out of a longer file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mi-cut-"));
    const src = join(dir, "long.wav");
    execFileSync(ffmpegPath(), [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=330:duration=6:sample_rate=48000",
      src,
    ]);
    const out = join(dir, "range.wav");
    await cutAudio(src, out, 1.5, 4);
    const samples = await decodeAudio(out);
    expect(samples.length / WHISPER_SAMPLE_RATE).toBeCloseTo(2.5, 1);
  });

  it("explains a file it cannot read", async () => {
    await expect(decodeAudio("/nonexistent/file.wav")).rejects.toThrow(/could not read/);
  });
});

describe("listStyles", () => {
  it("finds all eleven style presets", () => {
    expect(listStyles(stylesDir())).toHaveLength(11);
    expect(listStyles(stylesDir())).toContain("kil-lacivert");
  });
});

describe("parseRange", () => {
  it("parses seconds and rejects bad ranges", () => {
    expect(parseRange("12.5-42")).toEqual({ startS: 12.5, endS: 42 });
    expect(() => parseRange("42-12")).toThrow(/after the start/);
    expect(() => parseRange("abc")).toThrow(/Invalid range/);
  });
});
