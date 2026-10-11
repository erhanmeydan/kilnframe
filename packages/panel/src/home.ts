// os.homedir() returns null while a UXP panel is still loading (seen in Premiere 26.5.2) and the real path a
// moment later, so everything that needs the home folder waits for it.
import { t } from "./i18n";
const os = require("os") as { homedir(): string | null; platform?: () => string };

let cached: string | null = null;

export function homeDirNow(): string | null {
  if (!cached) {
    const h = os.homedir();
    if (h) cached = h.replace(/\\/g, "/");
  }
  return cached;
}

export async function homeDir(timeoutMs = 10_000): Promise<string> {
  const started = Date.now();
  for (;;) {
    const h = homeDirNow();
    if (h) return h;
    if (Date.now() - started > timeoutMs) throw new Error(t("home.noHome"));
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** True on Windows: from os.platform() when UXP has it, else from the shape of the home folder (C:\\...). */
export function isWindows(): boolean {
  const p = os.platform?.();
  if (p) return p === "win32";
  return /^[a-z]:/i.test(os.homedir() ?? "");
}

/**
 * A path as the operating system writes it, for Premiere's own calls. The panel keeps paths with "/", which
 * Premiere on Windows turns into \\?\C:\...\Kilnframe/job/sequence.wav, and Windows refuses a "/" after that
 * prefix ("Unable To Delete Existing File", 11 Oct 2026).
 */
export function nativePath(path: string): string {
  return isWindows() ? path.replace(/\//g, "\\") : path;
}

/** True when two paths name the same file, whichever slashes and letter case Windows gave them. */
export function samePath(a: string, b: string): boolean {
  if (!isWindows()) return a === b;
  const norm = (p: string) => p.replace(/\//g, "\\").toLowerCase();
  return norm(a) === norm(b);
}

/**
 * A Windows path without the \\?\ long-path prefix Premiere gives project paths (11 Oct 2026). FFmpeg and other
 * tools refuse it ("Invalid argument"), and it is not needed for paths of a normal length.
 */
export function withoutLongPathPrefix(path: string): string {
  if (path.startsWith("\\\\?\\UNC\\")) return `\\\\${path.slice(8)}`;
  if (path.startsWith("\\\\?\\") || path.startsWith("//?/")) return path.slice(4);
  return path;
}
