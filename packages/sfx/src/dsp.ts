import { SAMPLE_RATE } from "./constants.js";

/** Seeded PRNG (mulberry32), so every render of a plan sounds the same. */
export function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal noise via Box-Muller. */
export function whiteNoise(n: number, rnd: () => number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 2) {
    const u = Math.max(rnd(), 1e-12);
    const v = rnd();
    const r = Math.sqrt(-2 * Math.log(u));
    out[i] = r * Math.cos(2 * Math.PI * v);
    if (i + 1 < n) out[i + 1] = r * Math.sin(2 * Math.PI * v);
  }
  return out;
}

export const samples = (seconds: number) => Math.max(1, Math.round(seconds * SAMPLE_RATE));

/** exp(-t / tau) decay envelope. */
export function expEnvelope(n: number, tau: number): Float32Array {
  const out = new Float32Array(n);
  const k = 1 / (tau * SAMPLE_RATE);
  for (let i = 0; i < n; i++) out[i] = Math.exp(-i * k);
  return out;
}

export function multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] as number) * (b[i] ?? 0);
  return out;
}

/** Sine oscillator following a per-sample frequency curve (phase accumulates, no clicks). */
export function sweptSine(freqAt: (i: number) => number, n: number): Float32Array {
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    phase += (2 * Math.PI * freqAt(i)) / SAMPLE_RATE;
    out[i] = Math.sin(phase);
  }
  return out;
}

/** In-place iterative radix-2 FFT (inverse when `inverse` is true, unscaled). */
function fftInPlace(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j] as number, re[i] as number];
      [im[i], im[j]] = [im[j] as number, im[i] as number];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const vr = (re[b] as number) * cr - (im[b] as number) * ci;
        const vi = (re[b] as number) * ci + (im[b] as number) * cr;
        re[b] = (re[a] as number) - vr;
        im[b] = (im[a] as number) - vi;
        re[a] = (re[a] as number) + vr;
        im[a] = (im[a] as number) + vi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

/**
 * Zero-phase filter in the frequency domain with a magnitude curve, exactly like the original
 * Python script (numpy rfft, multiply, irfft). The signal is zero-padded to a power of two.
 */
export function fftFilter(x: Float32Array, magnitude: (hz: number) => number): Float32Array {
  const n = 1 << Math.ceil(Math.log2(Math.max(2, x.length)));
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(x);
  fftInPlace(re, im, false);
  for (let k = 0; k < n; k++) {
    const bin = k <= n / 2 ? k : n - k;
    const g = magnitude((bin * SAMPLE_RATE) / n);
    re[k] = (re[k] as number) * g;
    im[k] = (im[k] as number) * g;
  }
  fftInPlace(re, im, true);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = (re[i] as number) / n;
  return out;
}

const lowCurve = (hz: number, cutoff: number) => 1 / Math.sqrt(1 + (hz / cutoff) ** 4);
const highCurve = (hz: number, cutoff: number) =>
  1 / Math.sqrt(1 + (cutoff / Math.max(hz, 1)) ** 4);

export function lowpass(x: Float32Array, cutoff: number): Float32Array {
  return fftFilter(x, (hz) => lowCurve(hz, cutoff));
}

export function highpass(x: Float32Array, cutoff: number): Float32Array {
  return fftFilter(x, (hz) => highCurve(hz, cutoff));
}

/** Band-pass between lo and hi with the original script's curves (12 dB per octave each side). */
export function band(x: Float32Array, lo: number, hi: number): Float32Array {
  return fftFilter(x, (hz) => lowCurve(hz, hi) * highCurve(hz, lo));
}

export function rms(x: Float32Array): number {
  let s = 0;
  for (const v of x) s += v * v;
  return Math.sqrt(s / Math.max(1, x.length));
}

export function peak(x: Float32Array): number {
  let p = 0;
  for (const v of x) p = Math.max(p, Math.abs(v));
  return p;
}
