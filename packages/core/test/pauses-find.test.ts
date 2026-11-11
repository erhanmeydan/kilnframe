import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ffmpegPath } from "../src/config.js";
import { VAD_FRAME_S, findSpeech, speechStartsEarlier, type VadStream } from "../src/index.js";

function hasFfmpeg(): boolean {
  try {
    execFileSync(ffmpegPath(), ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** A 48 kHz WAV of 440 Hz bursts over [a, b) seconds, silence elsewhere. */
function bursts(bursts: [number, number][], durationS: number): string {
  const dir = mkdtempSync(join(tmpdir(), "kf-pauses-"));
  const file = join(dir, "bursts.wav");
  const on = bursts.map(([a, b]) => `between(t,${a},${b})`).join("+");
  execFileSync(ffmpegPath(), [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `aevalsrc='if(${on},0.5*sin(2*PI*440*t),0)':s=48000:d=${durationS}`,
    file,
  ]);
  return file;
}

/** Scores a frame by its loudness instead of the voice model. */
function energyVad(onPush?: (frames: number) => void): VadStream & { frames: number } {
  const s = {
    frames: 0,
    push(frame: Float32Array) {
      s.frames++;
      onPush?.(s.frames);
      let sum = 0;
      for (const v of frame) sum += v * v;
      return Promise.resolve(Math.sqrt(sum / frame.length) > 0.05 ? 0.9 : 0);
    },
  };
  return s;
}

/** FFmpeg processes started by this test process. */
function ffmpegChildren(): string[] {
  try {
    return execFileSync("pgrep", ["-P", String(process.pid), "-f", "ffmpeg"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

// within one frame: a frame the burst reaches counts as loud
const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(VAD_FRAME_S);

describe.skipIf(!hasFfmpeg())("findSpeech", () => {
  it("finds the bursts within one frame and reports the length read", async () => {
    const file = bursts(
      [
        [1, 2],
        [3.5, 4.5],
      ],
      6,
    );
    const progress: number[] = [];
    const r = await findSpeech({
      audioPath: file,
      model: "unused",
      vad: energyVad(),
      onProgress: (d) => progress.push(d),
    });
    expect(r.speech).toHaveLength(2);
    near(r.speech[0]![0], 1);
    near(r.speech[0]![1], 2);
    near(r.speech[1]![0], 3.5);
    near(r.speech[1]![1], 4.5);
    expect(r.durationS).toBeCloseTo(6, 2);
    expect(progress.at(-1)).toBe(1);
    expect(progress.every((p, i) => p >= 0 && p <= 1 && (i === 0 || p >= progress[i - 1]!))).toBe(
      true,
    );
  });

  it("reads only the range and gives times from its start", async () => {
    const file = bursts(
      [
        [1, 2],
        [3.5, 4.5],
      ],
      6,
    );
    const r = await findSpeech({
      audioPath: file,
      rangeStartS: 3,
      rangeEndS: 5,
      model: "unused",
      vad: energyVad(),
    });
    expect(r.durationS).toBeCloseTo(2, 2);
    expect(r.speech).toHaveLength(1);
    near(r.speech[0]![0], 0.5);
    near(r.speech[0]![1], 1.5);
  });

  it.skipIf(process.platform === "win32")(
    "streams: frames arrive while FFmpeg still runs, and abort leaves no FFmpeg",
    async () => {
      const file = bursts([[1, 2]], 120);
      const ac = new AbortController();
      let runningAtFirstFrame = false;
      const vad = energyVad((n) => {
        if (n === 1) runningAtFirstFrame = ffmpegChildren().length > 0;
        if (n === 100) ac.abort();
      });
      await expect(
        findSpeech({ audioPath: file, model: "unused", vad, signal: ac.signal }),
      ).rejects.toThrow();
      expect(runningAtFirstFrame).toBe(true);
      // 120 s is 3750 frames: far from all were decoded into memory before the model saw the first
      expect(vad.frames).toBeLessThan(200);
      await new Promise((r) => setTimeout(r, 100));
      expect(ffmpegChildren()).toEqual([]);
    },
  );

  it("an already aborted signal rejects at once", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      findSpeech({ audioPath: "/nope.wav", model: "unused", vad: energyVad(), signal: ac.signal }),
    ).rejects.toThrow();
  });

  it("an unreadable file says so", async () => {
    await expect(
      findSpeech({ audioPath: "/no/such/file.wav", model: "unused", vad: energyVad() }),
    ).rejects.toThrow(/FFmpeg could not read/);
  });
});

describe("speech starts at its sound", () => {
  // the room at -70 dB, a word's soft start at -45 dB from 0.80 s, its voiced part from 1.00 s
  const levels = (soft: number, voiced: number, until: number) => {
    const l = new Float32Array(300).fill(-70);
    for (let i = Math.round(soft * 100); i < Math.round(voiced * 100); i++) l[i] = -45;
    for (let i = Math.round(voiced * 100); i < Math.round(until * 100); i++) l[i] = -25;
    return l;
  };

  it("moves a start back to where the word's soft sound begins", () => {
    expect(speechStartsEarlier([[1, 2]], levels(0.8, 1, 2))).toEqual([[0.8, 2]]);
  });

  it("goes back at most 250 ms, never into the speech before, and leaves a hard start alone", () => {
    expect(speechStartsEarlier([[1, 2]], levels(0.3, 1, 2))[0]![0]).toBeCloseTo(0.75);
    expect(
      speechStartsEarlier(
        [
          [0, 0.9],
          [1, 2],
        ],
        levels(0.8, 1, 2),
      )[1]![0],
    ).toBeCloseTo(0.9, 1);
    expect(speechStartsEarlier([[1, 2]], levels(1, 1, 2))).toEqual([[1, 2]]);
  });
});
