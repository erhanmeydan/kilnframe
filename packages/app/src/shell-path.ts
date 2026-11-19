import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

const MARK = "__KILNFRAME_PATH__";

/** Where the agents and their Node usually live when the login shell cannot be read. */
function commonDirs(home: string): string[] {
  return [
    posix.join(home, ".local", "bin"), // Claude Code's native installer
    posix.join(home, ".claude", "local"),
    posix.join(home, ".grok", "bin"),
    posix.join(home, ".npm-global", "bin"),
    posix.join(home, ".bun", "bin"),
    posix.join(home, ".volta", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
}

/** Reads PATH from the user's login shell, with its rc files, once; null when it fails or takes too long. */
export function loginShellPath(shell = process.env.SHELL || "/bin/zsh"): string | null {
  try {
    const out = execFileSync(shell, ["-ilc", `printf '${MARK}%s${MARK}' "$PATH"`], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    // rc files may print their own lines; only the marked part counts
    return out.split(MARK)[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * The PATH for the companion. An app opened from Finder or at login gets only /usr/bin:/bin:/usr/sbin:/sbin
 * on macOS, so it would not find Claude Code, Codex or Grok, which live in the user's home or Homebrew and
 * are found through the shell's PATH. On Windows the user's PATH is kept, with the agents' usual folders added.
 */
export function companionPath(
  current = process.env.PATH ?? "",
  platform = process.platform,
  readShell: () => string | null = loginShellPath,
  home = homedir(),
): string {
  if (platform === "win32") {
    // Windows apps inherit the user's PATH, but one started before an agent was installed keeps the old one:
    // each agent's installer puts it in its own folder, which may not be on PATH yet (or ever: Claude Code's)
    const sep = ";";
    const appData = process.env.APPDATA ?? win32.join(home, "AppData", "Roaming");
    const localAppData = process.env.LOCALAPPDATA ?? win32.join(home, "AppData", "Local");
    const extra = [
      win32.join(home, ".local", "bin"), // Claude Code
      win32.join(localAppData, "Programs", "OpenAI", "Codex", "bin"), // Codex's installer
      win32.join(home, ".grok", "bin"), // Grok Build
      win32.join(appData, "npm"),
    ].filter((d) => existsSync(d));
    return [...new Set([...current.split(sep), ...extra].filter(Boolean))].join(sep);
  }
  // macOS: ":" whatever computer runs this (the tests run on Windows too)
  const dirs = [
    ...(readShell() ?? "").split(posix.delimiter),
    ...current.split(posix.delimiter),
    ...commonDirs(home).filter((d) => existsSync(d)),
  ].filter(Boolean);
  return [...new Set(dirs)].join(posix.delimiter);
}
