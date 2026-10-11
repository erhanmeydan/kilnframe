import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SAMPLE_RATE,
  SYNTHS,
  dbToGain,
  decodeWav16,
  encodeWav16,
  fftFilter,
  gainToDb,
  mixCues,
  mulberry32,
  parsePalette,
  peak,
  rms,
  whiteNoise,
  type SfxPalette,
} from "../src/index.js";

const stylesDir = join(import.meta.dirname, "../../../styles");

describe("gain helpers", () => {
  it("round-trips dB and gain", () => {
    expect(SAMPLE_RATE).toBe(48_000);
    expect(dbToGain(-6)).toBeCloseTo(0.501, 3);
    expect(gainToDb(dbToGain(-12))).toBeCloseTo(-12, 10);
  });
});

describe("fftFilter", () => {
  it("passes the band and attenuates far outside it", () => {
    const x = whiteNoise(48_000, mulberry32(3));
    const tone = (hz: number) =>
      Float32Array.from({ length: 48_000 }, (_, i) =>
        Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE),
      );
    const lp = (hz: number) => 1 / Math.sqrt(1 + (hz / 1000) ** 4);
    expect(rms(fftFilter(tone(200), lp)) / rms(tone(200))).toBeGreaterThan(0.95);
    expect(rms(fftFilter(tone(8000), lp)) / rms(tone(8000))).toBeLessThan(0.02);
    expect(fftFilter(x, () => 1)[100]).toBeCloseTo(x[100] as number, 5);
  });
});

describe("synths", () => {
  it("produce audible, finite, deterministic sounds", () => {
    for (const [name, synth] of Object.entries(SYNTHS)) {
      const a = synth({}, mulberry32(9));
      const b = synth({}, mulberry32(9));
      expect(a.length, name).toBeGreaterThan(SAMPLE_RATE * 0.05);
      expect(a.every(Number.isFinite), name).toBe(true);
      expect(peak(a), name).toBeGreaterThan(0.05);
      expect(Array.from(a.slice(0, 500)), name).toEqual(Array.from(b.slice(0, 500)));
    }
  });
});

describe("wav", () => {
  it("round-trips 16-bit stereo and clips out-of-range samples", () => {
    const l = Float32Array.from([0, 0.5, -0.5, 2]);
    const r = Float32Array.from([0.25, -1, 1, -3]);
    const { sampleRate, channels } = decodeWav16(encodeWav16([l, r]));
    expect(sampleRate).toBe(48_000);
    expect(channels[0]?.[1]).toBeCloseTo(0.5, 3);
    expect(channels[0]?.[3]).toBeCloseTo(1, 3);
    expect(channels[1]?.[3]).toBeCloseTo(-1, 3);
  });
});

describe("palettes", () => {
  it("every style ships a valid sfx.json", () => {
    const styles = readdirSync(stylesDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    expect(styles).toHaveLength(11);
    for (const s of styles) {
      const path = join(stylesDir, s.name, "sfx.json");
      expect(
        () => parsePalette(JSON.parse(readFileSync(path, "utf8")), path),
        s.name,
      ).not.toThrow();
    }
  });

  it("explains a broken palette", () => {
    expect(() =>
      parsePalette({
        version: 1,
        master_db: -6,
        pan: 0.2,
        room: { enabled: false, db: -60 },
        sounds: { a: { synth: "laser" } },
      }),
    ).toThrow(/unknown synth "laser"/);
    expect(() => parsePalette({ version: 2 })).toThrow(/version/);
  });
});

describe("mixCues", () => {
  const palette: SfxPalette = {
    version: 1,
    master_db: 0,
    pan: 0,
    room: { enabled: false, db: -60 },
    sounds: { pop: { synth: "pop" }, thock: { synth: "thock" } },
  };

  it("places each cue at its time, in its own stem and in the mix", () => {
    const r = mixCues({
      palette,
      durationS: 2,
      cues: [
        { timeS: 0.5, sound: "pop", gainDb: -6 },
        { timeS: 1.2, sound: "thock", gainDb: -6 },
      ],
    });
    expect(r.mix.left.length).toBe(96_000);
    expect([...r.stems.keys()].sort()).toEqual(["pop", "thock"]);
    const pop = r.stems.get("pop")?.left as Float32Array;
    const firstSound = pop.findIndex((v) => Math.abs(v) > 1e-4);
    expect(firstSound / SAMPLE_RATE).toBeCloseTo(0.5, 2);
    expect(peak(r.mix.left.subarray(0, 23_000))).toBe(0);
  });

  it("skips unknown sounds and cues after the end, and is deterministic", () => {
    const opts = {
      palette,
      durationS: 1,
      cues: [
        { timeS: 0.1, sound: "laser", gainDb: -6 },
        { timeS: 1.5, sound: "pop", gainDb: -6 },
        { timeS: 0.2, sound: "thock", gainDb: -6 },
      ],
    };
    const a = mixCues(opts);
    expect(a.skipped.map((s) => s.reason)).toEqual([
      '"laser" is not in the style\'s sound palette',
      "after the end of the insert",
    ]);
    expect(Array.from(mixCues(opts).mix.left.slice(9_600, 10_600))).toEqual(
      Array.from(a.mix.left.slice(9_600, 10_600)),
    );
  });

  it("adds room tone under everything with soft fades", () => {
    const r = mixCues({
      palette: { ...palette, room: { enabled: true, db: -54 } },
      durationS: 2,
      cues: [],
    });
    const room = r.stems.get("room")?.left as Float32Array;
    expect(Math.abs(room[0] as number)).toBeLessThan(1e-6);
    expect(gainToDb(rms(room.subarray(24_000, 72_000)))).toBeCloseTo(-54, 0);
  });
});
