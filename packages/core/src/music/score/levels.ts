// packages/core/src/music/score/levels.ts
// Music levels as an editor reads them on Premiere's or Resolve's audio meter: peaks in dBFS. The "meter level"
// of a stretch is the 95th percentile of its 400 ms window peaks, so a single transient does not set it.
import type { Word } from "../../schemas/transcript.js";

const WINDOW_S = 0.4;
const GAP_S = 1.5;
const DUCK_LEAD_S = 0.3;
const RISE_S = 0.5;
const GAP_LIFT_DB = 6;
const FINAL_RAMP_S = 20;
const FINAL_LIFT_DB = 4;

const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-9));
const gain = (d: number) => 10 ** (d / 20);

export function meterLevelDb(
  channels: Float32Array[],
  sampleRate: number,
  fromS = 0,
  toS = Infinity,
): number {
  const n = channels[0]?.length ?? 0;
  const a = Math.max(0, Math.floor(fromS * sampleRate));
  const b = Math.min(n, Math.floor(toS * sampleRate));
  const win = Math.max(1, Math.round(WINDOW_S * sampleRate));
  const peaks: number[] = [];
  for (let s = a; s < b; s += win) {
    let p = 0;
    for (const ch of channels)
      for (let i = s; i < Math.min(b, s + win); i++) p = Math.max(p, Math.abs(ch[i]!));
    peaks.push(p);
  }
  if (!peaks.length) return -Infinity;
  peaks.sort((x, y) => x - y);
  return db(peaks[Math.min(peaks.length - 1, Math.floor(peaks.length * 0.95))]!);
}

export function speechSpans(words: Word[], gapS = GAP_S): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  for (const w of words) {
    const last = spans.at(-1);
    if (last && w.start - last.end < gapS) last.end = Math.max(last.end, w.end);
    else spans.push({ start: w.start, end: w.end });
  }
  return spans;
}

export interface GainPlan {
  slider: number;
  rangeDurationS: number;
  spans: { start: number; end: number }[];
  finalRampS?: number;
}

/** How far into a duck we are at `t`: 1 inside speech, 0 in a gap, linear on the ramps. */
function duckAmount(t: number, spans: { start: number; end: number }[]): number {
  let amount = 0;
  for (const s of spans) {
    if (t >= s.start && t <= s.end) return 1;
    if (t < s.start && t >= s.start - DUCK_LEAD_S)
      amount = Math.max(amount, 1 - (s.start - t) / DUCK_LEAD_S);
    if (t > s.end && t <= s.end + RISE_S) amount = Math.max(amount, 1 - (t - s.end) / RISE_S);
  }
  return amount;
}

export function levelAt(t: number, p: GainPlan): number {
  const rampS = p.finalRampS ?? FINAL_RAMP_S;
  const into = t - (p.rangeDurationS - rampS);
  const lift = into > 0 ? (FINAL_LIFT_DB * Math.min(into, rampS)) / rampS : 0;
  const ducked = p.slider + lift;
  // in the final ramp the gap level never drops below the ramped speech level
  const open = Math.max(p.slider + GAP_LIFT_DB, ducked);
  return open + (ducked - open) * duckAmount(t, p.spans);
}

export function normalizeTo(
  channels: Float32Array[],
  sampleRate: number,
  targetDb: number,
): Float32Array[] {
  const g = gain(targetDb - meterLevelDb(channels, sampleRate));
  return channels.map((ch) => ch.map((v) => v * g));
}

export function applyLevels(
  channels: Float32Array[],
  sampleRate: number,
  offsetS: number,
  p: GainPlan,
  baseDb: number,
): Float32Array[] {
  const step = Math.round(sampleRate / 100); // the curve is evaluated every 10 ms and held between
  return channels.map((ch) => {
    const out = new Float32Array(ch.length);
    for (let s = 0; s < ch.length; s += step) {
      const g = gain(levelAt(offsetS + s / sampleRate, p) - baseDb);
      for (let i = s; i < Math.min(ch.length, s + step); i++) out[i] = ch[i]! * g;
    }
    return out;
  });
}

export function limitPeak(channels: Float32Array[], ceilingDb = -1.5): Float32Array[] {
  const ceiling = gain(ceilingDb);
  let p = 0;
  for (const ch of channels) for (const v of ch) p = Math.max(p, Math.abs(v));
  if (p <= ceiling) return channels;
  const g = ceiling / p;
  return channels.map((ch) => ch.map((v) => v * g));
}
