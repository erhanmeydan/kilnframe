// Version strings from many upstreams: semver, four-part Chrome, FFmpeg build ids, dated tags, commit shas.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PRE = /-(alpha|beta|rc|canary|next|dev|nightly|pre|preview)\b/i;
export const isPrerelease = (v) => PRE.test(v);

/** The numbers in a version, in order: "1789931890_9.0.2" gives [1789931890, 9, 0, 2]. */
const numbers = (v) => (v.match(/\d+/g) ?? []).map(Number);

export function compare(a, b) {
  const x = numbers(a);
  const y = numbers(b);
  if (!x.length || !y.length) return a === b ? 0 : a < b ? -1 : 1;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

const SEMVER = /^\d+\.\d+\.\d+/;
/** How big a step from one version to the next is; "other" when either is not semver. */
export function bump(from, to) {
  if (from === to) return "none";
  if (!SEMVER.test(from) || !SEMVER.test(to)) return "other";
  const [a, b] = [numbers(from), numbers(to)];
  if (a[0] !== b[0]) return "major";
  if (a[1] !== b[1]) return "minor";
  return "patch";
}

export function loadDeps(root) {
  return JSON.parse(readFileSync(join(root, "deps.json"), "utf8")).deps;
}
