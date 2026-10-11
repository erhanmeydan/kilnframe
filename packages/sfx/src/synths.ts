// Ported from reels-giris-inserts/tools/make-sfx.py (numpy). Same formulas and the same FFT filter
// curves, so the sounds match the original project.
import { SAMPLE_RATE } from "./constants.js";
import {
  band,
  expEnvelope,
  lowpass,
  highpass,
  multiply,
  rms,
  samples,
  sweptSine,
  whiteNoise,
} from "./dsp.js";

export type Rng = () => number;
export type Params = Record<string, number>;
export type Synth = (p: Params, rnd: Rng) => Float32Array;

const num = (p: Params, key: string, fallback: number) =>
  typeof p[key] === "number" ? (p[key] as number) : fallback;

/** A clay object settling on a table: low pitched thud plus a short textured click. */
export const thock: Synth = (p, rnd) => {
  const size = num(p, "size", 1);
  const n = samples(0.28);
  const f0 = 150 / size ** 0.4;
  const body = multiply(
    sweptSine((i) => f0 * (1 + 0.8 * Math.exp(-i / SAMPLE_RATE / 0.012)), n),
    expEnvelope(n, 0.045),
  );
  const click = multiply(band(whiteNoise(n, rnd), 500, 2500), expEnvelope(n, 0.006));
  const g = size ** 0.5;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++)
    out[i] = ((body[i] as number) * 0.9 + (click[i] as number) * 0.35) * g;
  return out;
};

/** A paper sheet landing: bright noise burst over a small thock. */
export const paper: Synth = (_p, rnd) => {
  const n = samples(0.3);
  const x = multiply(band(whiteNoise(n, rnd), 900, 5000), expEnvelope(n, 0.05));
  const fade = samples(0.004);
  for (let i = 0; i < fade; i++) x[i] = (x[i] as number) * (i / fade);
  const th = thock({ size: 0.6 }, rnd);
  for (let i = 0; i < n; i++) x[i] = (x[i] as number) * 0.5 + (th[i] ?? 0) * 0.5;
  return x;
};

/** Air moving past: noise swept from a low band to a high band. */
export const whoosh: Synth = (p, rnd) => {
  const dur = num(p, "dur", 0.8);
  const lo = num(p, "lo", 300);
  const hi = num(p, "hi", 2600);
  const pk = num(p, "peak", 0.6);
  const n = samples(dur);
  const noise = whiteNoise(n, rnd);
  const a = band(noise, lo, lo * 3);
  const b = band(noise, hi / 3, hi);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0;
    const rise = Math.sin((Math.PI * Math.min(1, t / pk)) / 2) ** 2;
    const fall = t > pk ? Math.cos(((Math.PI / 2) * (t - pk)) / (1 - pk)) ** 2 : 1;
    out[i] = ((a[i] as number) * (1 - t) + (b[i] as number) * t) * rise * fall;
  }
  return out;
};

/** A soft rising pop. */
export const pop: Synth = (p) => {
  const f = num(p, "freq", 620);
  const n = samples(0.09);
  const tone = sweptSine((i) => f * (1 + (0.5 * i) / SAMPLE_RATE / 0.09), n);
  const env = expEnvelope(n, 0.02);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++)
    out[i] = (tone[i] as number) * (env[i] as number) * Math.min(1, i / SAMPLE_RATE / 0.003);
  return out;
};

/** Two quick mouse-button ticks. */
export const click: Synth = (p, rnd) => {
  const gap = num(p, "gap", 0.028);
  const count = Math.max(1, Math.round(num(p, "count", 2)));
  const n = samples(gap * (count - 1) + 0.032);
  const out = new Float32Array(n);
  const m = samples(0.008);
  for (let c = 0; c < count; c++) {
    const burst = multiply(band(whiteNoise(m, rnd), 1800, 6000), expEnvelope(m, 0.0015));
    const off = samples(c * gap);
    for (let i = 0; i < m && off + i < n; i++)
      out[off + i] = (out[off + i] as number) + (burst[i] as number);
  }
  return out;
};

/** A gentle rising shimmer with a fifth above. */
export const shimmer: Synth = (p) => {
  const dur = num(p, "dur", 1);
  const n = samples(dur);
  const f = (i: number) => 520 + 260 * (i / n);
  const a = sweptSine(f, n);
  const b = sweptSine((i) => f(i) * 1.5, n);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++)
    out[i] =
      ((a[i] as number) + 0.4 * (b[i] as number)) * Math.sin((Math.PI * i) / n) ** 1.5 * 0.35;
  return out;
};

/** A settling chime: three decaying partials. */
export const chime: Synth = (p) => {
  const base = num(p, "freq", 880);
  const n = samples(0.9);
  const out = new Float32Array(n);
  const partials: [number, number, number][] = [
    [1, 0.6, 0.35],
    [1.5, 0.35, 0.25],
    [2, 0.15, 0.15],
  ];
  for (const [ratio, amp, decay] of partials) {
    const env = expEnvelope(n, decay);
    for (let i = 0; i < n; i++) {
      out[i] =
        (out[i] as number) +
        amp * Math.sin((2 * Math.PI * base * ratio * i) / SAMPLE_RATE) * (env[i] as number);
    }
  }
  for (let i = 0; i < n; i++) out[i] = (out[i] as number) * Math.min(1, i / SAMPLE_RATE / 0.004);
  return out;
};

/** Pen, marker or chalk on a surface: band noise with a fast seeded amplitude flutter. */
export const scratch: Synth = (p, rnd) => {
  const dur = num(p, "dur", 0.4);
  const lo = num(p, "lo", 1500);
  const hi = num(p, "hi", 6000);
  const n = samples(dur);
  const x = band(whiteNoise(n, rnd), lo, hi);
  const step = samples(0.012);
  let level = 0.5;
  let target = 0.5;
  for (let i = 0; i < n; i++) {
    if (i % step === 0) target = 0.25 + rnd() * 0.75;
    level += (target - level) * 0.01;
    const edge = Math.min(1, i / samples(0.01), (n - 1 - i) / samples(0.03));
    x[i] = (x[i] as number) * level * edge * 0.6;
  }
  return x;
};

/** Very low room tone: brown noise kept between 30 and 400 Hz, normalized to RMS 1. */
export function roomTone(durationS: number, rnd: Rng): Float32Array {
  const n = samples(durationS);
  const w = whiteNoise(n, rnd);
  let acc = 0;
  const brown = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    acc = acc * 0.999 + (w[i] as number) * 0.02;
    brown[i] = acc;
  }
  const x = highpass(lowpass(brown, 400), 30);
  const r = rms(x) + 1e-9;
  for (let i = 0; i < n; i++) x[i] = (x[i] as number) / r;
  return x;
}

export const SYNTHS: Record<string, Synth> = {
  thock,
  paper,
  whoosh,
  pop,
  click,
  shimmer,
  chime,
  scratch,
};
