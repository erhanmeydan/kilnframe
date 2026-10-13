import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { KeyStore } from "./keys.js";

/**
 * The project was called motion-insert until 9 Oct 2026. Data kept under that name moves to the new one
 * the first time the companion starts: the settings folder (own styles, caches) and the speech model
 * (about 1 GB, moved rather than copied) by renaming the folder, the API keys by copying them to the new
 * keychain service. The old keychain entries are left in place; nothing is deleted.
 */
export function moveLegacyFolders(home = homedir()): string[] {
  const moves: [string, string][] = [
    [join(home, ".motion-insert"), join(home, ".kilnframe")],
    [join(home, ".cache", "motion-insert"), join(home, ".cache", "kilnframe")],
  ];
  const done: string[] = [];
  for (const [from, to] of moves) {
    if (!existsSync(from) || existsSync(to)) continue;
    try {
      renameSync(from, to);
      done.push(to);
    } catch {
      // another volume or a locked file: the new folder starts empty, the old one stays
    }
  }
  return done;
}

/**
 * Copies every key the old service holds and the new one lacks; returns the providers copied. It runs once
 * (a marker in ~/.kilnframe): the old entries stay, so copying on every start brought back a key the editor
 * had deleted in the settings.
 */
export async function copyLegacyKeys(
  from: KeyStore,
  to: KeyStore,
  providers: string[],
  home = homedir(),
): Promise<string[]> {
  const marker = join(home, ".kilnframe", "legacy-keys-copied");
  if (existsSync(marker)) return [];
  const copied: string[] = [];
  for (const id of providers) {
    try {
      if ((await to.get(id)) !== undefined) continue;
      const key = await from.get(id);
      if (key === undefined) continue;
      await to.set(id, key);
      copied.push(id);
    } catch {
      // a keychain prompt declined or no access: that key is entered again in the settings
    }
  }
  try {
    mkdirSync(join(home, ".kilnframe"), { recursive: true });
    writeFileSync(marker, `${new Date().toISOString()}\n`);
  } catch {
    // no marker: the copy runs again next start, as before
  }
  return copied;
}
