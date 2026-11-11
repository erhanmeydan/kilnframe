/** The pauses must leave at least this much of a recording (seconds)... */
export const SILENCE_KEEP_MIN_S = 1;
/** ...and this share of it, while that share is under SILENCE_KEEP_SHARE_UNDER_S. */
export const SILENCE_KEEP_MIN_SHARE = 0.02;
export const SILENCE_KEEP_SHARE_UNDER_S = 3;

/**
 * Whether the pauses of a recording `durationS` long, leaving `keptS` of it, cut it away: under 1 s is left,
 * or under 2 % of it while that is also under 3 s. A long recording with a short talk in it stays cuttable;
 * a voice model finding a breath of "speech" in a minute of room tone or music does not empty the timeline.
 */
export function emptiedBySilence(keptS: number, durationS: number): boolean {
  const share = Math.min(SILENCE_KEEP_MIN_SHARE * durationS, SILENCE_KEEP_SHARE_UNDER_S);
  const need = Math.min(durationS, Math.max(SILENCE_KEEP_MIN_S, share));
  return keptS < need - 1e-3;
}
