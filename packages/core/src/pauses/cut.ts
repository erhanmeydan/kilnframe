import { emptiedBySilence } from "./guard.js";

/** A stretch of the audio to remove, in seconds from its start. */
export interface PauseCut {
  startS: number;
  endS: number;
}

/** Silence kept on each side of a cut, so words never start or end clipped (up to the middle of the slider). */
export const SILENCE_PAD_S = 0.15;

const clamp01 = (strictness: number) => Math.min(1, Math.max(0, strictness));

/** How tight the cut is past the slider's middle: 0 at the middle, 1 at Tight (a jump cut). */
const past = (strictness: number) => Math.max(0, (clamp01(strictness) - 0.5) / 0.5);

/**
 * The shortest pause that is cut: 1.2 s at strictness 0 and 0.775 s at the middle; from there to Tight it
 * falls to 0.12 s, so every breath between words goes (a jump cut).
 */
export function silenceGapS(strictness: number): number {
  const s = clamp01(strictness);
  return s <= 0.5 ? 1.2 + (0.35 - 1.2) * s : 0.775 + (0.12 - 0.775) * past(s);
}

/** Silence kept beside a cut: 0.15 s up to the middle, down to 0.05 s at Tight, just enough not to clip a word. */
export function silencePadS(strictness: number): number {
  return SILENCE_PAD_S + (0.05 - SILENCE_PAD_S) * past(strictness);
}

/**
 * Room kept before speech starts (a piece's start): none. Speech starts where its sound begins
 * (speechStartsEarlier), and the editors cut on whole frames rounded away from the speech, which keeps up to
 * a frame (40 ms at 25 fps) of the room before the word anyway; 0.03 s more showed as a gap before the clip.
 */
export function leadPadS(_strictness: number): number {
  return 0;
}

/**
 * Silence kept after speech ends (a piece's end): 0.05 s up to the middle, 0.03 s at Tight. The voice
 * model marks the end where the voice fades (on a real talk within 40 ms of the sound falling to the room);
 * the 0.12 s kept before left an audible hang after each sentence.
 */
export function tailPadS(strictness: number): number {
  return 0.05 + (0.03 - 0.05) * past(strictness);
}

/**
 * Pauses cut from the voice model's speech stretches alone: every gap between speech longer than
 * silenceGapS(strictness), less a short pad before the speech that follows and after the speech before.
 * No word times are needed (Whisper stretches words over pauses and invents some in silence); the edges of
 * the recording need no pad, unless `rangeEdges` says the audio is a part cut from a longer timeline: there a
 * word may straddle the edge, so the pads are kept at the edges too.
 */
export function cutPauses(
  speech: [number, number][],
  durationS: number,
  strictness: number,
  o: { rangeEdges?: boolean } = {},
): PauseCut[] {
  if (!speech.length) return [];
  const minGap = silenceGapS(strictness);
  const lead = leadPadS(strictness);
  const tail = tailPadS(strictness);
  const cuts: PauseCut[] = [];
  const push = (a: number, b: number) => {
    if (b - a > 0.04) cuts.push({ startS: +a.toFixed(3), endS: +b.toFixed(3) });
  };
  const edges = Boolean(o.rangeEdges);
  let at = 0;
  speech.forEach(([a, b], i) => {
    if (a - at > minGap) push(i === 0 && !edges ? 0 : at + tail, a - lead);
    at = Math.max(at, b);
  });
  if (durationS - at > minGap) push(at + tail, edges ? durationS - lead : durationS);
  return cuts;
}

export interface PausePlan {
  cuts: PauseCut[];
  /** Seconds the cuts remove. */
  removedS: number;
  /** Seconds left; removedS + keptS is the duration. */
  keptS: number;
  /** Pauses longer than keepLongS, left in (empty unless keepLongS is given). */
  longKept: PauseCut[];
  /** The cuts would have left almost nothing (emptiedBySilence): `cuts` is empty. */
  emptied: boolean;
}

/**
 * The pauses to remove at a strictness, with their totals. Every pause is cut, however long: a stretch with
 * no speech on the chosen track (a music intro, a B-roll montage) goes too, since pauses are removed first
 * in an edit, before such parts are built. `keepLongS` keeps pauses longer than that whole instead. A plan
 * that would leave almost nothing cuts nothing: the track holds no talk worth cutting around.
 */
export function planPauseCuts(
  speech: [number, number][],
  durationS: number,
  o: { strictness: number; keepLongS?: number | null; rangeEdges?: boolean },
): PausePlan {
  const all = cutPauses(speech, durationS, o.strictness, { rangeEdges: o.rangeEdges ?? false });
  const keepLong = o.keepLongS ?? null;
  const isLong = (c: PauseCut) => keepLong !== null && c.endS - c.startS > keepLong;
  const cuts = all.filter((c) => !isLong(c));
  const longKept = all.filter(isLong);
  const removedS = cuts.reduce((sum, c) => sum + (c.endS - c.startS), 0);
  const keptS = durationS - removedS;
  if (cuts.length && emptiedBySilence(keptS, durationS))
    return { cuts: [], removedS: 0, keptS: durationS, longKept, emptied: true };
  return { cuts, removedS, keptS, longKept, emptied: false };
}
