// The files the Resolve panel's page may read and write through the main process: only Kilnframe's own folder
// (~/.kilnframe: the companion's connection file, the panel log). A symlink there may not lead elsewhere.
// Besides, a caption SRT the companion wrote in a job folder may be copied to where the editor picks.
import { existsSync, realpathSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";

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

/**
 * Copies a caption SRT (in a job folder anywhere in the home folder, links followed) to the path `pick` returns,
 * the editor's save dialog; null, with nothing written, when the editor cancelled.
 */
export async function saveCopy(
  source: string,
  suggestedName: string,
  home: string,
  pick: (suggestedName: string) => Promise<string | null>,
): Promise<string | null> {
  const refuse = () => new Error(`Not a caption file in the home folder: ${source}`);
  const full = resolve(source);
  if (extname(full).toLowerCase() !== ".srt" || !full.startsWith(resolve(home) + sep))
    throw refuse();
  const real = realpathSync(full);
  if (!real.startsWith(realpathSync(home) + sep)) throw refuse();
  const target = await pick(suggestedName);
  if (!target) return null;
  await copyFile(real, target);
  return target;
}
