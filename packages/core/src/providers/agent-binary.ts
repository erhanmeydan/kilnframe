import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { win32 } from "node:path";

/**
 * Finding the editor's agent CLIs (claude, codex, grok). On macOS the plain name is enough. On Windows it is
 * not: an npm install is a .cmd shim, which a shell-less spawn never finds (libuv looks for .exe and .com only),
 * and the companion starts at sign-in with the PATH of that moment, so an agent installed later stays unseen.
 * So on Windows every lookup reads PATH fresh from the registry, also looks in the installers' own folders, and
 * runs an npm shim's script with Node directly instead of through cmd (a long system prompt with quotes and line
 * breaks cannot pass through cmd's quoting).
 */
export type AgentName = "claude" | "codex" | "grok";

export interface AgentCommand {
  /** The program to start. */
  file: string;
  /** Arguments that go before the agent's own (the script of an npm shim). */
  prefix: string[];
  /** Extra environment for the program (Electron running as Node). */
  env: Record<string, string>;
}

export interface AgentLookup {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** PATH values from the registry, user first, unexpanded. */
  registryPaths: () => string[];
  exists: (path: string) => boolean;
  read: (path: string) => string;
  /** This program: Electron in the app, which runs a script as Node with ELECTRON_RUN_AS_NODE. */
  execPath: string;
}

const OVERRIDE: Record<AgentName, string> = {
  claude: "KILNFRAME_CLAUDE",
  codex: "KILNFRAME_CODEX",
  grok: "KILNFRAME_GROK",
};

/** "%USERPROFILE%\\x" with the environment's values; unknown names stay as they are. */
export function expandWinVars(text: string, env: NodeJS.ProcessEnv): string {
  return text.replace(/%([^%]+)%/g, (all, name: string) => {
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? (env[key] ?? all) : all;
  });
}

/** The Path value in `reg query ... /v Path` output, or "" when there is none. */
export function parseRegPath(output: string): string {
  return /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/im.exec(output)?.[1] ?? "";
}

function readRegistryPaths(): string[] {
  const keys = [
    "HKCU\\Environment",
    "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
  ];
  return keys.map((key) => {
    const r = spawnSync("reg", ["query", key, "/v", "Path"], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    return r.status === 0 ? parseRegPath(r.stdout) : "";
  });
}

/** Where to look on Windows: the registry's PATH, then the process's own, then the installers' folders. */
export function windowsSearchDirs(env: NodeJS.ProcessEnv, registryPaths: string[]): string[] {
  const home = env.USERPROFILE ?? "";
  const known = [
    // Claude Code's native installer
    home && win32.join(home, ".local", "bin"),
    // npm and pnpm global installs (claude, codex)
    env.APPDATA && win32.join(env.APPDATA, "npm"),
    env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, "pnpm"),
    // xAI's install.ps1 (GROK_BIN_DIR, else %USERPROFILE%\.grok\bin)
    env.GROK_BIN_DIR,
    home && win32.join(home, ".grok", "bin"),
    // OpenAI's Codex install.ps1
    env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, "Programs", "OpenAI", "Codex", "bin"),
    // winget and Scoop
    env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links"),
    home && win32.join(home, "scoop", "shims"),
  ];
  const all = [...registryPaths, env.PATH ?? env.Path ?? ""]
    .flatMap((p) => expandWinVars(p, env).split(";"))
    .concat(known.filter((d): d is string => !!d));
  const seen = new Set<string>();
  return all
    .map((d) => d.trim().replace(/^"|"$/g, ""))
    .filter((d) => {
      const key = d.toLowerCase();
      if (!d || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** The script an npm .cmd shim runs ("node_modules\\pkg\\cli.js"), or null for any other batch file. */
export function cmdShimTarget(text: string): string | null {
  return /"%~?dp0%?\\([^"]+\.(?:c|m)?js)"/i.exec(text)?.[1] ?? null;
}

function firstFile(dirs: string[], names: string[], exists: (p: string) => boolean): string | null {
  for (const dir of dirs)
    for (const name of names) {
      const path = win32.join(dir, name);
      if (exists(path)) return path;
    }
  return null;
}

/** How to start an agent CLI on this computer. */
export function agentCommand(
  agent: AgentName,
  lookup: AgentLookup = defaultLookup(),
): AgentCommand {
  const override = lookup.env[OVERRIDE[agent]];
  if (override) return { file: override, prefix: [], env: {} };
  if (lookup.platform !== "win32") return { file: agent, prefix: [], env: {} };
  const dirs = windowsSearchDirs(lookup.env, lookup.registryPaths());
  const found = firstFile(dirs, [`${agent}.exe`, `${agent}.cmd`, `${agent}.bat`], lookup.exists);
  if (!found) return { file: agent, prefix: [], env: {} };
  if (/\.exe$/i.test(found)) return { file: found, prefix: [], env: {} };
  const target = cmdShimTarget(lookup.read(found));
  if (!target) {
    // a batch file that is not an npm shim: cmd runs it (only short, plain arguments reach it this way)
    return { file: lookup.env.ComSpec ?? "cmd.exe", prefix: ["/d", "/c", found], env: {} };
  }
  const script = win32.join(win32.dirname(found), target);
  const nextTo = win32.join(win32.dirname(found), "node.exe");
  const node = lookup.exists(nextTo) ? nextTo : firstFile(dirs, ["node.exe"], lookup.exists);
  if (node) return { file: node, prefix: [script], env: {} };
  // no Node on this computer: the app's own Electron runs the script as Node
  return { file: lookup.execPath, prefix: [script], env: { ELECTRON_RUN_AS_NODE: "1" } };
}

/** fn's result, kept for `ms`: one status refresh asks for several agents in a row. */
export function remembered<T>(fn: () => T, ms: number, now: () => number = Date.now): () => T {
  let at = -Infinity;
  let value: T;
  return () => {
    if (now() - at >= ms) {
      value = fn();
      at = now();
    }
    return value;
  };
}

// each lookup spawns `reg query` twice; a settings refresh looks up three agents several times
const registryPathsNow = remembered(readRegistryPaths, 5_000);

function defaultLookup(): AgentLookup {
  return {
    platform: process.platform,
    env: process.env,
    registryPaths: registryPathsNow,
    exists: (p) => existsSync(p),
    read: (p) => readFileSync(p, "utf8"),
    execPath: process.execPath,
  };
}

/** Program, arguments and environment for running an agent with its own arguments. */
export function agentSpawn(
  agent: AgentName,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  const cmd = agentCommand(agent);
  return { file: cmd.file, args: [...cmd.prefix, ...args], env: { ...env, ...cmd.env } };
}

/** spawnSync for an agent CLI, found as agentCommand finds it. */
export function spawnAgentSync(
  agent: AgentName,
  args: string[],
  opts: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string> {
  const run = agentSpawn(agent, args, opts.env ?? process.env);
  return spawnSync(run.file, run.args, { ...opts, env: run.env, windowsHide: true });
}

/** spawn (piped stdio) for an agent CLI, found as agentCommand finds it. */
export function spawnAgent(
  agent: AgentName,
  args: string[],
  opts: SpawnOptionsWithoutStdio,
): ChildProcessWithoutNullStreams {
  const run = agentSpawn(agent, args, opts.env ?? process.env);
  return spawn(run.file, run.args, { ...opts, env: run.env, windowsHide: true, stdio: "pipe" });
}

/**
 * The environment for a terminal window the editor sees (an agent's sign-in or update): Windows only, with one
 * Path read fresh from the registry, so an agent installed after the companion started is found there too.
 */
export function withFreshPath(
  env: NodeJS.ProcessEnv,
  registryPaths: string[] = readRegistryPaths(),
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (k.toLowerCase() !== "path") out[k] = v;
  out.Path = windowsSearchDirs(env, registryPaths).join(";");
  return out;
}
