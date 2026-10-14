/** Checks whose reason the panel can say in the editor's language; the rest are covered by the sentence. */
const KNOWN = ["overlay_faint_layer", "scene_shows_nothing"] as const;
export type CheckKey = `check.${(typeof KNOWN)[number]}`;

/**
 * A job error the panel can say in its own language instead of the core's English: today the
 * composition that failed its checks after the repair rounds. The English original goes to the log.
 */
export function readableJobError(
  message: string,
): { key: "job.checksFailed"; vars: { n: number }; reasons: CheckKey[] } | null {
  const m = /still fails validation after (\d+) repair rounds/.exec(message);
  if (!m) return null;
  const reasons = KNOWN.filter((code) => message.includes(`${code}:`)).map(
    (code) => `check.${code}` as CheckKey,
  );
  return { key: "job.checksFailed", vars: { n: Number(m[1]) }, reasons };
}
