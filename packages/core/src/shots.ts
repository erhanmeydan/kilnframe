// Frames of the assembled project taken once and shared: the pixel checks (haze, empty scenes) and the
// review stills look at nearly the same moments, and every `hyperframes snapshot` run costs about 2.3 s of
// browser start before its first frame (0.28 s per frame after). The last check round takes all of them in
// one run; the stills reuse them while the project is unchanged.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { snapshotProject } from "./hyperframes.js";

/** Takes one PNG per time and returns them in the order given. */
export type Shooter = (times: number[]) => Promise<string[]>;

/** A time as the shots are keyed (snapshot itself is given millisecond precision). */
const key = (t: number) => t.toFixed(3);

/** What the frames depend on: the project's index and its scene files. */
export function projectHash(projectDir: string): string {
  const h = createHash("sha1");
  h.update(readFileSync(join(projectDir, "index.html")));
  const comps = join(projectDir, "compositions");
  for (const f of existsSync(comps) ? readdirSync(comps).sort() : []) {
    h.update(f);
    h.update(readFileSync(join(comps, f)));
  }
  return h.digest("hex");
}

/** A fresh snapshot run into `dir` for each call. */
export function snapshotShooter(projectDir: string, dir: string): Shooter {
  return async (times) => {
    rmSync(dir, { recursive: true, force: true });
    return (await snapshotProject(projectDir, times, dir)).files;
  };
}

interface Manifest {
  hash: string;
  files: Record<string, string>;
}

/**
 * Takes all `times` in one snapshot run into `dir` and records them with the project's hash, so the stills
 * can reuse them later (cachedShooter).
 */
export async function takeShots(
  projectDir: string,
  times: number[],
  dir: string,
): Promise<Shooter> {
  const unique = [...new Map(times.map((t) => [key(t), t])).values()].sort((a, b) => a - b);
  const files = await snapshotShooter(projectDir, dir)(unique);
  const manifest: Manifest = {
    hash: projectHash(projectDir),
    files: Object.fromEntries(unique.map((t, i) => [key(t), files[i] as string])),
  };
  writeFileSync(join(dir, "shots.json"), `${JSON.stringify(manifest)}\n`);
  return fromManifest(manifest, snapshotShooter(projectDir, join(dir, "more")));
}

/** Serves the recorded times from the manifest; a set with any other time goes to `fallback`. */
function fromManifest(m: Manifest, fallback: Shooter): Shooter {
  return async (times) => {
    const files = times.map((t) => m.files[key(t)]);
    if (files.every((f): f is string => !!f && existsSync(f))) return files;
    return fallback(times);
  };
}

/**
 * The shots a check round left in `dir`, when they were taken of the project as it is now; null when there
 * are none or the scenes changed since.
 */
export function cachedShooter(projectDir: string, dir: string, fallback: Shooter): Shooter | null {
  try {
    const m = JSON.parse(readFileSync(join(dir, "shots.json"), "utf8")) as Manifest;
    if (m.hash !== projectHash(projectDir)) return null;
    return fromManifest(m, fallback);
  } catch {
    return null;
  }
}
