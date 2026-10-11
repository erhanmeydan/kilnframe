import { SAMPLE_RATE } from "./constants.js";
import { mulberry32, samples } from "./dsp.js";
import type { SfxPalette } from "./palette.js";
import { SYNTHS, roomTone } from "./synths.js";

export interface Cue {
  /** Seconds on the delivered timeline (handles included). */
  timeS: number;
  /** Name of a sound in the palette. */
  sound: string;
  gainDb: number;
}

export interface Stereo {
  left: Float32Array;
  right: Float32Array;
}

export interface MixResult {
  mix: Stereo;
  /** One full-length stem per sound name, plus "room" when enabled. */
  stems: Map<string, Stereo>;
  /** Cues that were skipped, with the reason. */
  skipped: { cue: Cue; reason: string }[];
}

const db = (v: number) => 10 ** (v / 20);
const silent = (n: number): Stereo => ({ left: new Float32Array(n), right: new Float32Array(n) });

/** Equal-power pan, matching the original script (unity at center). */
function place(dst: Stereo, x: Float32Array, at: number, gain: number, pan: number) {
  const gl = Math.sqrt(0.5 - pan / 2) * Math.SQRT2 * gain;
  const gr = Math.sqrt(0.5 + pan / 2) * Math.SQRT2 * gain;
  const n = dst.left.length;
  for (let i = 0; i < x.length && at + i < n; i++) {
    if (at + i < 0) continue;
    dst.left[at + i] = (dst.left[at + i] as number) + (x[i] as number) * gl;
    dst.right[at + i] = (dst.right[at + i] as number) + (x[i] as number) * gr;
  }
}

export interface MixOptions {
  cues: Cue[];
  palette: SfxPalette;
  durationS: number;
  seed?: number;
}

/** Synthesizes every cue, writes it into its sound's stem and into the mix. Deterministic for a seed. */
export function mixCues({ cues, palette, durationS, seed = 11 }: MixOptions): MixResult {
  const n = samples(durationS);
  const mix = silent(n);
  const stems = new Map<string, Stereo>();
  const skipped: MixResult["skipped"] = [];
  const panRnd = mulberry32(seed * 97);

  cues.forEach((cue, index) => {
    const def = palette.sounds[cue.sound];
    if (!def) {
      skipped.push({ cue, reason: `"${cue.sound}" is not in the style's sound palette` });
      return;
    }
    const synth = SYNTHS[def.synth];
    if (!synth) {
      skipped.push({ cue, reason: `unknown synth "${def.synth}"` });
      return;
    }
    const at = Math.round(cue.timeS * SAMPLE_RATE);
    if (at >= n) {
      skipped.push({ cue, reason: "after the end of the insert" });
      return;
    }
    const x = synth(def.params ?? {}, mulberry32(seed + index * 7919));
    const gain = db(cue.gainDb + (def.gain_db ?? 0) + palette.master_db);
    const pan = (panRnd() * 2 - 1) * palette.pan;
    let stem = stems.get(cue.sound);
    if (!stem) {
      stem = silent(n);
      stems.set(cue.sound, stem);
    }
    place(stem, x, at, gain, pan);
    place(mix, x, at, gain, pan);
  });

  if (palette.room.enabled) {
    const rnd = mulberry32(seed + 1);
    const r = roomTone(durationS, rnd);
    const g = db(palette.room.db);
    const fade = Math.min(samples(0.3), Math.floor(n / 2));
    const room = silent(n);
    const shift = Math.min(2400, n - 1);
    for (let i = 0; i < n; i++) {
      const f = Math.min(1, i / fade, (n - 1 - i) / fade);
      room.left[i] = (r[i] as number) * g * f;
      room.right[i] = (r[(i + shift) % n] as number) * g * f;
      mix.left[i] = (mix.left[i] as number) + (room.left[i] as number);
      mix.right[i] = (mix.right[i] as number) + (room.right[i] as number);
    }
    stems.set("room", room);
  }
  return { mix, stems, skipped };
}
