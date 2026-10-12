// The files the Resolve panel's page may read and write through the main process: only Kilnframe's own folder
// (~/.kilnframe: the companion's connection file, the panel log). A symlink there may not lead elsewhere.
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

/** The path, when it is inside ~/.kilnframe once links are followed; throws otherwise. */
export function kilnframeFile(path: string, home: string): string {
  const root = join(home, ".kilnframe");
  const full = resolve(path);
  const refuse = () => new Error(`Not inside ${root}: ${path}`);
  if (!full.startsWith(root + sep)) throw refuse();
  // the nearest part of the path that exists, with its links followed, must still be inside
  let existing = full;
  while (!existsSync(existing)) existing = dirname(existing);
  const realRoot = realpathSync(root);
  const real = realpathSync(existing);
  if (real !== realRoot && !real.startsWith(realRoot + sep)) throw refuse();
  return full;
}
