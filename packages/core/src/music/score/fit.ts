// packages/core/src/music/score/fit.ts
// Fitting a Lyria piece to its section and joining sections. Two clips cannot overlap on one track, so a
// crossfade is baked into the head of the next clip: the previous clip stops where the next one begins.
import { SR } from "./audio-io.js";

const LOOP_XF_S = 3;
const n = (s: number) => Math.round(s * SR);

const cut = (ch: Float32Array[], from: number, to: number) => ch.map((c) => c.slice(from, to));

/** Appends `b` to `a` from sample `at`, crossfading `len` samples in equal power (a(t)^2 + b(t)^2 = 1). */
function mixIn(a: Float32Array[], b: Float32Array[], at: number, len: number): Float32Array[] {
  return a.map((c, k) => {
    const bc = b[k]!;
    const out = new Float32Array(at + bc.length);
    out.set(c.subarray(0, at));
    for (let i = 0; i < len; i++) {
      const t = i / len;
      out[at + i] =
        (c[at + i] ?? 0) * Math.cos((t * Math.PI) / 2) + bc[i]! * Math.sin((t * Math.PI) / 2);
    }
    out.set(bc.subarray(len), at + len);
    return out;
  });
}

/** Energy per 10 ms window, mono. */
export function energy(ch: Float32Array[]): number[] {
  const w = n(0.01);
  const out: number[] = [];
  for (let s = 0; s + w <= ch[0]!.length; s += w) {
    let e = 0;
    for (const c of ch) for (let i = s; i < s + w; i++) e += c[i]! * c[i]!;
    out.push(e / (w * ch.length));
  }
  return out;
}

export function fitLength(ch: Float32Array[], seconds: number, keepEnd: boolean): Float32Array[] {
  const want = n(seconds);
  let cur = ch;
  const xf = n(LOOP_XF_S);
  while (cur[0]!.length < want) cur = mixIn(cur, ch, cur[0]!.length - xf, xf);
  if (cur[0]!.length === want) return cur;
  if (!keepEnd) return cut(cur, 0, want);
  // keep the close: drop a stretch before it, joining at the quietest 10 ms window near the cut point
  const extra = cur[0]!.length - want;
  const tail = n(Math.min(8, seconds / 3));
  const e = energy(cur);
  const joinAt = cur[0]!.length - tail; // samples after this are the close we keep
  let best = joinAt - extra;
  let quiet = Infinity;
  for (let s = Math.max(xf, joinAt - extra - n(2)); s <= joinAt - extra; s += n(0.01)) {
    const v = e[Math.floor(s / n(0.01))] ?? Infinity;
    if (v < quiet) {
      quiet = v;
      best = s;
    }
  }
  const head = cut(cur, 0, best + n(0.25));
  const rest = cut(cur, best + extra, cur[0]!.length);
  return cut(mixIn(head, rest, best, n(0.25)), 0, want);
}

export function fade(ch: Float32Array[], inS: number, outS: number): Float32Array[] {
  return ch.map((c) => {
    const o = c.slice();
    const a = n(inS);
    const b = n(outS);
    for (let i = 0; i < a && i < o.length; i++) o[i]! *= i / a;
    for (let i = 0; i < b && i < o.length; i++) o[o.length - 1 - i]! *= i / b;
    return o;
  });
}

export function bakeCrossfade(
  prevFull: Float32Array[],
  next: Float32Array[],
  seconds = 2.5,
): { prev: Float32Array[]; next: Float32Array[] } {
  const xf = n(seconds);
  const keep = prevFull[0]!.length - xf;
  const prevTail = cut(prevFull, keep, prevFull[0]!.length);
  const head = next.map((c, k) => {
    const o = c.slice();
    for (let i = 0; i < xf && i < o.length; i++) {
      const t = i / xf;
      o[i] = prevTail[k]![i]! * Math.cos((t * Math.PI) / 2) + c[i]! * Math.sin((t * Math.PI) / 2);
    }
    return o;
  });
  return { prev: cut(prevFull, 0, keep), next: head };
}
