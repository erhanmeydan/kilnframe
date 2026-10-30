// FilmCraft (storytold/filmcraft) has no plugin system. Kilnframe talks to it over its control channel, which
// FilmCraft only opens when it is started with --control <port> and FILMCRAFT_CONTROL_TOKEN. This module finds
// the program, says whether it runs, and starts it that way; the port and token stay in memory.
import { execFile, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { posix, win32 } from "node:path";

/** FilmCraft's program, or null when it is not installed. */
export function findFilmCraft(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: (p: string) => boolean,
  home: string,
): string | null {
  let candidates: string[];
  if (platform === "darwin") {
    const inApps = (base: string) =>
      posix.join(base, "Applications/FilmCraft.app/Contents/MacOS/FilmCraft");
    candidates = [inApps("/"), inApps(home)];
  } else if (platform === "win32") {
    const programs = env.ProgramFiles ?? env.PROGRAMFILES ?? "C:\\Program Files";
    const local = env.LOCALAPPDATA ?? win32.join(home, "AppData", "Local");
    // FilmCraft's own MSI (packaging/windows/filmcraft.wxs, 0.14.x) installs filmcraft.exe under ArtCraft, for
    // everyone or for the current user; the plain FilmCraft folder is kept as a fallback for other builds
    candidates = [
      win32.join(programs, "ArtCraft", "FilmCraft", "filmcraft.exe"),
      win32.join(local, "Programs", "ArtCraft", "FilmCraft", "filmcraft.exe"),
      win32.join(programs, "FilmCraft", "FilmCraft.exe"),
      win32.join(local, "Programs", "FilmCraft", "FilmCraft.exe"),
    ];
  } else {
    return null;
  }
  return candidates.find((p) => exists(p)) ?? null;
}

/** A free loopback port. */
export function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => ok(port));
    });
  });
}

export type FilmCraftState = "not-installed" | "open-without-kilnframe" | "ours" | "closed";

/** `ours`: FilmCraft runs and this app holds its port and token. A FilmCraft started by hand cannot be reached. */
export function filmCraftState(
  running: boolean,
  ours: boolean,
  installed: boolean,
): FilmCraftState {
  if (running) return ours ? "ours" : "open-without-kilnframe";
  return installed ? "closed" : "not-installed";
}

type Exec = (cmd: string, args: string[]) => Promise<string>;

const run: Exec = (cmd, args) =>
  new Promise((ok, fail) =>
    execFile(cmd, args, { timeout: 10_000, windowsHide: true }, (err, stdout) =>
      err ? fail(err) : ok(stdout),
    ),
  );

/** Whether a FilmCraft process exists, whoever started it. */
export async function filmCraftRunning(
  platform: NodeJS.Platform,
  exec: Exec = run,
): Promise<boolean> {
  try {
    if (platform === "win32") {
      const out = await exec("tasklist", [
        "/FI",
        "IMAGENAME eq FilmCraft.exe",
        "/FO",
        "CSV",
        "/NH",
      ]);
      return /filmcraft\.exe/i.test(out);
    }
    // pgrep exits 1 without a match, which exec reports as a failure
    await exec("pgrep", ["-x", "FilmCraft"]);
    return true;
  } catch {
    return false;
  }
}

export type ChannelAnswer = "ok" | "refused" | "no-answer";

/**
 * How the channel on `port` takes `ui.inspect` with this token: `ok`; `refused` (an error reply, or nothing
 * listening); `no-answer` when no reply comes within `limitMs` (FilmCraft busy). Never throws.
 */
export function channelAnswer(port: number, token: string, limitMs = 2000): Promise<ChannelAnswer> {
  return new Promise((done) => {
    const s = createConnection({ host: "127.0.0.1", port });
    let buffer = "";
    let connected = false;
    let finished = false;
    const finish = (value: ChannelAnswer) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      s.destroy();
      done(value);
    };
    const timer = setTimeout(() => finish("no-answer"), limitMs);
    s.setEncoding("utf8");
    s.once("connect", () => {
      connected = true;
      s.write(JSON.stringify({ id: 1, token, method: "ui.inspect", params: {} }) + "\n");
    });
    s.on("data", (chunk: string) => {
      buffer += chunk;
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      try {
        const ok = (JSON.parse(buffer.slice(0, nl)) as { ok?: boolean }).ok === true;
        finish(ok ? "ok" : "refused");
      } catch {
        finish("refused");
      }
    });
    // before the connection is made, an error means nothing listens; a connection dropped without a reply
    // says nothing about the token
    s.on("error", () => finish(connected ? "no-answer" : "refused"));
    s.on("close", () => finish(connected ? "no-answer" : "refused"));
  });
}

/** Whether the channel on `port` answers `ui.inspect` with ok. Never throws. */
export async function probeChannel(port: number, token: string, limitMs = 2000): Promise<boolean> {
  return (await channelAnswer(port, token, limitMs)) === "ok";
}

export interface LaunchDeps {
  spawn?: (
    program: string,
    args: string[],
    options: SpawnOptions,
  ) => {
    unref(): void;
    once?(event: "error", cb: (err: Error) => void): unknown;
    on(event: "error", cb: (err: Error) => void): unknown;
  };
  port?: () => Promise<number>;
  probe?: (port: number, token: string) => Promise<boolean>;
  /** Pause between readiness checks. */
  intervalMs?: number;
  /** How long to wait for the channel before giving up. */
  timeoutMs?: number;
}

export const LAUNCH_LIMIT_MS = 30_000;

/** Starts FilmCraft with the channel open; resolves once it answers, rejects after 30 s. */
export async function launchFilmCraft(
  program: string,
  deps: LaunchDeps = {},
): Promise<{ port: number; token: string }> {
  const {
    spawn = nodeSpawn as NonNullable<LaunchDeps["spawn"]>,
    port: pickPort = freePort,
    probe = probeChannel,
    intervalMs = 500,
    timeoutMs = LAUNCH_LIMIT_MS,
  } = deps;
  const port = await pickPort();
  // the token reaches FilmCraft through its environment only, never an argument others can read with ps
  const token = randomBytes(32).toString("hex");
  const child = spawn(program, ["--control", String(port)], {
    env: { ...process.env, FILMCRAFT_CONTROL_TOKEN: token },
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  // FilmCraft is the user's editor: it keeps running when Kilnframe quits
  child.unref();
  let startError: Error | null = null;
  child.on("error", (err) => {
    startError = err;
  });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (startError) {
      throw new Error(`FilmCraft could not be started: ${(startError as Error).message}`);
    }
    if (await probe(port, token)) return { port, token };
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  // not killed: it may be the user's editor with work open, and it is only the channel that is missing
  throw new Error(
    "FilmCraft did not answer on its control channel in time. Close FilmCraft and try again.",
  );
}

/** The menu's Open FilmCraft item, only when FilmCraft is installed. */
export function filmCraftMenuItems<C>(
  program: string | null,
  label: string,
  click: C,
): { label: string; click: C }[] {
  return program ? [{ label, click }] : [];
}

export interface Endpoint {
  port: number;
  token: string;
}

export interface OpenerDeps {
  /** Looked up on every open: FilmCraft may have moved since. */
  program: () => string;
  running: () => Promise<boolean>;
  /** How the FilmCraft on this endpoint takes this token (channelAnswer). */
  answers: (ep: Endpoint) => Promise<ChannelAnswer>;
  launch: (program: string) => Promise<Endpoint>;
  showPanel: () => void;
  /** FilmCraft runs without the channel: a second start would only bring it forward. */
  openWithoutKilnframe: () => void;
  failed: (err: Error) => void;
}

/**
 * The menu's Open FilmCraft: starts FilmCraft with its channel when it is closed, leaves one opened another way
 * alone, and opens the panel beside it. The endpoint lives here, in memory only.
 */
export function createFilmCraftOpener(deps: OpenerDeps) {
  let endpoint: Endpoint | null = null;
  let opening: Promise<void> | null = null;

  async function open(): Promise<void> {
    const running = await deps.running();
    // a FilmCraft started by hand since then refuses our token; a busy one (exporting) may not answer in time
    // and stays ours, so the open panel keeps its connection
    const ours = running && endpoint !== null && (await deps.answers(endpoint)) !== "refused";
    if (!ours) endpoint = null;
    const state = filmCraftState(running, ours, true);
    if (state === "open-without-kilnframe") return deps.openWithoutKilnframe();
    if (state === "closed") {
      try {
        endpoint = await deps.launch(deps.program());
      } catch (err) {
        return deps.failed(err instanceof Error ? err : new Error(String(err)));
      }
    }
    deps.showPanel();
  }

  return {
    /** A second click while FilmCraft starts waits for the first. */
    open(): Promise<void> {
      opening ??= open().finally(() => {
        opening = null;
      });
      return opening;
    },
    endpoint: (): Endpoint | null => endpoint,
  };
}
