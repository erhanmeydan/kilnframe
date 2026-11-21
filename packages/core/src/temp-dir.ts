import { rmSync } from "node:fs";

/**
 * Removes a temporary work folder without ever failing the work that used it. On Windows a folder cannot be
 * deleted while a process (an agent CLI's child, Chrome) still runs in it or a virus scanner holds a file,
 * and the removal fails with EPERM or EBUSY; a leftover folder in the system temp folder is harmless, an
 * error that replaces a finished answer is not.
 */
export function removeTempDir(dir: string, rm: typeof rmSync = rmSync): void {
  try {
    rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // left for the system to clear
  }
}
