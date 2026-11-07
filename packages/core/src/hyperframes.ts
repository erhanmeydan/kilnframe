import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);

/** Path to the pinned HyperFrames CLI (packages/core/package.json). */
export function hyperframesBin(): string {
  const pkgPath = require.resolve("hyperframes/package.json");
  const pkg = require(pkgPath) as { bin: Record<string, string> };
  return join(dirname(pkgPath), pkg.bin.hyperframes as string);
}

/** Folders an app keeps HyperFrames' own files in, instead of ~/.cache/hyperframes and its settings folder. */
export interface HyperframesDirs {
  /** HYPERFRAMES_CACHE_DIR: project history (a copy of every file it saw), warm-up tokens. */
  cacheDir?: string;
  /** HYPERFRAMES_CONFIG_DIR: settings, install state and the list of running commands. */
  configDir?: string;
}

let dirs: HyperframesDirs = {};

/**
 * Every later HyperFrames run keeps its caches and settings in these folders (HyperFrames 0.9.16 and up), so
 * an app can size and clean them; an empty object gives HyperFrames its own folders back. For a caller that does not
 * set the environment of its own (the core's tests, a script): an app that starts job processes sets
 * HYPERFRAMES_CACHE_DIR and HYPERFRAMES_CONFIG_DIR in process.env instead, which every process it starts inherits
 * (the desktop does, at start) and hyperframesEnv passes on; this setter is the process's own only.
 */
export function setHyperframesDirs(d: HyperframesDirs): void {
  dirs = { ...d };
}

/**
 * The environment a HyperFrames run gets: the caller's, quiet, without the warm check, and the app's folders when
 * it set them.
 *
 * CI turns off 0.9's warm check: a check run without a terminal starts, as it ends, a detached process that
 * launches a Chrome and idles five minutes in the project folder for the next check. Being detached, it escapes
 * every kill of the job's process tree, so it outlived Cancel and quit, and on Windows the folder it holds cannot
 * be removed. CI is HyperFrames' only switch for it; in 0.9.19 CI otherwise only turns off colours (NO_COLOR does
 * already), the render feedback prompt (off with telemetry), the update check, the desktop app hint and
 * telemetry's CI field, and on Windows lets the setup prompts draw their Unicode symbols.
 */
export function hyperframesEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    HYPERFRAMES_NO_TELEMETRY: "1",
    DO_NOT_TRACK: "1",
    NO_COLOR: "1",
    CI: "1",
  };
  if (dirs.cacheDir) env.HYPERFRAMES_CACHE_DIR = dirs.cacheDir;
  if (dirs.configDir) env.HYPERFRAMES_CONFIG_DIR = dirs.configDir;
  return env;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
}

export function runHyperframes(
  args: string[],
  cwd: string,
  onLine?: (line: string) => void,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const proc = spawn(process.execPath, [hyperframesBin(), ...args], {
      cwd,
      env: hyperframesEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const feed = (chunk: Buffer, sink: "out" | "err") => {
      const text = chunk.toString();
      if (sink === "out") stdout += text;
      else stderr += text;
      if (onLine) for (const line of text.split("\n")) if (line.trim()) onLine(line);
    };
    proc.stdout.on("data", (c: Buffer) => feed(c, "out"));
    proc.stderr.on("data", (c: Buffer) => feed(c, "err"));
    proc.on("error", reject);
    proc.on("close", (code) =>
      resolve({ code: code ?? 1, stdout, stderr, ms: Date.now() - started }),
    );
  });
}

export interface CheckFinding {
  code?: string;
  severity: "error" | "warning" | "info";
  message: string;
  selector?: string;
  sourceFile?: string;
  time?: number;
  fixHint?: string;
  /** Which check pass reported it: lint, runtime, layout, motion, contrast, craft or audio. */
  section?: string;
}

interface CheckSection {
  ok: boolean;
  errorCount: number;
  findings?: CheckFinding[];
}

export interface CheckReport {
  ok: boolean;
  errors: CheckFinding[];
  warnings: CheckFinding[];
  raw: Record<string, unknown>;
}

/** A check pass's report: any top-level entry that carries findings. */
function isSection(value: unknown): value is Required<Pick<CheckSection, "findings">> {
  return (
    typeof value === "object" && value !== null && Array.isArray((value as CheckSection).findings)
  );
}

/**
 * Findings the app counts as warnings, though HyperFrames calls them errors, in a scene that draws on a canvas, as
 * "section:code". Elsewhere they stay errors.
 * - layout:canvas_covered (0.9.13 and up) fires when one opaque element spanning the frame sits above every other
 *   painted clip. Under a WebGL canvas that is a false positive: the audit cannot read the canvas's pixels, so the
 *   clay-3D layout (a background div at z-index 0, the canvas above it) is reported as covered while the stills
 *   show the figure in front of the background; as an error it sent the scene to repair rounds that could not fix
 *   it. In a scene without a canvas it is the slip it is meant to catch (a full-frame backdrop written after the
 *   chart or shapes it should be under), which no other check of the app catches in an overlay. To be reported
 *   upstream.
 */
const CANVAS_WARNINGS = new Set(["layout:canvas_covered"]);

/** Whether the scene a finding belongs to draws on a canvas; see inCanvasScene. */
export type InCanvasScene = (finding: CheckFinding) => boolean;

/** A <canvas> in a scene's markup, or one its script makes (a WebGL renderer adds its own). */
const DRAWS_ON_CANVAS = /<canvas\b|createElement\(\s*["'`]canvas["'`]\s*\)/i;

/**
 * Which of sceneIds a finding is placed in by its file (compositions/<id>.html) or its selector (#<id>-…, or the
 * scene's [data-composition-id]), else null.
 */
export function sceneOfFinding(f: CheckFinding, sceneIds: string[]): string | null {
  for (const id of sceneIds) {
    if (f.sourceFile?.includes(`compositions/${id}.html`)) return id;
    if (f.selector && new RegExp(`#${id}-|\\[data-composition-id="${id}"\\]`).test(f.selector))
      return id;
  }
  return null;
}

/**
 * For a finding of a check of projectDir: whether its scene (sceneOfFinding, over the project's compositions)
 * draws on a canvas. The root page and a scene not found say no.
 */
export function inCanvasScene(projectDir: string): InCanvasScene {
  const scenes = join(projectDir, "compositions");
  let ids: string[];
  try {
    ids = readdirSync(scenes)
      .filter((n) => n.endsWith(".html"))
      .map((n) => n.slice(0, -".html".length));
  } catch {
    ids = [];
  }
  return (f) => {
    const id = sceneOfFinding(f, ids);
    if (id === null) return false;
    try {
      return DRAWS_ON_CANVAS.test(readFileSync(join(scenes, `${id}.html`), "utf8"));
    } catch {
      return false;
    }
  };
}

/** The error the app gives a check, or a pass of it, that failed without listing why: a timeout, a budget cut short. */
const UNEXPLAINED = "The check failed without saying why.";

/**
 * Parses `hyperframes check --json` output into errors and warnings across all sections. Every section that
 * carries findings counts, not a fixed list: 0.8 had lint, runtime, layout, motion and contrast, 0.9 added
 * craft and audio, and a section left out would fail the top-level ok without a finding to say why. A finding
 * in CANVAS_WARNINGS is a warning when `onCanvas` says its scene draws on a canvas (inCanvasScene of the project
 * checked); without it, an error.
 *
 * The check passes when no error is left. A check HyperFrames failed with no error listed (a pass cut short, or one
 * whose failing count is more than the findings it reads as warnings here) gets an error of its own, per section
 * where one says so: a check counted as passed runs the app's later checks (haze, empty scenes) and renders.
 */
export function parseCheckJson(json: string, onCanvas: InCanvasScene = () => false): CheckReport {
  const start = json.indexOf("{");
  if (start < 0) throw new Error("hyperframes check did not return JSON.");
  const raw = JSON.parse(json.slice(start)) as Record<string, unknown>;
  const errors: CheckFinding[] = [];
  const warnings: CheckFinding[] = [];
  // the sections that failed with no error left to say why, and whether a demoted finding explains them
  const unexplained: string[] = [];
  let explained = 0;
  for (const [name, section] of Object.entries(raw)) {
    if (!isSection(section)) continue;
    let demoted = 0;
    let listed = 0;
    for (const f of section.findings) {
      if (f.severity === "error" && CANVAS_WARNINGS.has(`${name}:${f.code}`) && onCanvas(f)) {
        warnings.push({ ...f, severity: "warning", section: name });
        demoted++;
      } else if (f.severity === "error") {
        errors.push({ ...f, section: name });
        listed++;
      } else if (f.severity === "warning") warnings.push({ ...f, section: name });
    }
    if ((section as CheckSection).ok !== false || listed > 0) continue;
    const count = (section as CheckSection).errorCount ?? demoted;
    if (demoted > 0 && count === demoted) explained++;
    else unexplained.push(name);
  }
  if (raw.browserSkipped === true) {
    errors.push({
      severity: "error",
      message: "The browser checks did not run (layout, motion, contrast).",
    });
  }
  if (raw.ok !== true && errors.length === 0) {
    for (const section of unexplained) errors.push({ severity: "error", section, message: UNEXPLAINED });
    if (!unexplained.length && !explained) errors.push({ severity: "error", message: UNEXPLAINED });
  }
  return { ok: errors.length === 0, errors, warnings, raw };
}

export async function checkProject(projectDir: string): Promise<CheckReport & { ms: number }> {
  const r = await runHyperframes(["check", "--json"], projectDir);
  return { ...parseCheckJson(r.stdout, inCanvasScene(projectDir)), ms: r.ms };
}

export async function snapshotProject(
  projectDir: string,
  timesS: number[],
  outDir: string,
): Promise<RunResult> {
  const at = timesS.map((t) => t.toFixed(3)).join(",");
  const r = await runHyperframes(["snapshot", "--at", at, "--no-end", "-o", outDir], projectDir);
  if (r.code !== 0) throw new Error(`hyperframes snapshot failed:\n${r.stderr || r.stdout}`);
  stillsTaken(resolve(projectDir, outDir), timesS.length);
  return r;
}

/** A still snapshot names by default, frame-<n>-at-<t>s.png, numbered in the order of the --at times. */
const NUMBERED_STILL = /^frame-(\d+).*\.png$/;
/** A still snapshot --keep names, at-<t>s.png (0.8.159 and up): named for its time alone. */
const TIMED_STILL = /^at-(\d+(?:\.\d+)?)s\.png$/;

/**
 * The stills a snapshot run wrote into dir, in the order of their times: numbered stills by number (frame-100
 * comes after frame-99), timed ones by time. The contact sheet and anything else in the folder are left out.
 * A number and a time cannot be put in one order, so a folder with both (a --keep run into one of numbered
 * stills) gives the numbered ones only: the plain run's, which is what every caller here makes.
 */
export function snapshotStills(dir: string): string[] {
  const files = readdirSync(dir);
  const scheme = files.some((f) => NUMBERED_STILL.test(f)) ? NUMBERED_STILL : TIMED_STILL;
  return files
    .map((f) => ({ f, at: scheme.exec(f)?.[1] }))
    .filter((s): s is { f: string; at: string } => s.at !== undefined)
    .sort((a, b) => Number(a.at) - Number(b.at))
    .map((s) => join(dir, s.f));
}

/**
 * The stills a snapshot run wrote into dir (snapshotStills), and an error when there are fewer than the `count` times
 * it was asked for, naming what the folder holds. Every reader takes the stills in order, one per time: with one
 * missing, every later scene would be judged on the wrong frame, and with none (a later HyperFrames naming them
 * otherwise) the haze and empty-scene checks would find nothing and pass.
 */
export function stillsTaken(dir: string, count: number): string[] {
  let stills: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
    stills = snapshotStills(dir);
  } catch {
    // no folder: no stills
  }
  if (stills.length < count)
    throw new Error(
      `hyperframes snapshot was asked for ${count} stills and found ${stills.length} in ${dir}: ${names.join(", ") || "nothing"}`,
    );
  return stills;
}

export interface RenderOptions {
  fps: string;
  output: string;
  format: "mp4" | "mov";
  onLine?: (line: string) => void;
  /** Frames captured so far: given, the render runs without --quiet so HyperFrames reports them. */
  onFrames?: (done: number, total: number) => void;
  /**
   * Another render holds HyperFrames' render slot (0.9.14 and up: one render at a time per cache folder) and this
   * one waits for it; said once per holder. Its frames come once it runs.
   */
  onWait?: () => void;
}

/**
 * Whether a line is HyperFrames' word that the render waits for another to finish (its render slot): printed
 * once per holder while it waits, before any frame.
 */
export function waitsForRenderSlot(line: string): boolean {
  return line.trimStart().startsWith("Waiting for another render to finish");
}

/** A `@hf-progress {"code":"capture","done":…,"total":…}` line's frame counts, else null. */
export function capturedFrames(line: string): { done: number; total: number } | null {
  if (!line.startsWith("@hf-progress ")) return null;
  try {
    const p = JSON.parse(line.slice("@hf-progress ".length)) as Record<string, unknown>;
    if (p.code !== "capture" || typeof p.done !== "number" || typeof p.total !== "number")
      return null;
    return { done: p.done, total: p.total };
  } catch {
    return null;
  }
}

export async function renderProject(projectDir: string, o: RenderOptions): Promise<RunResult> {
  const args = ["render", "--fps", o.fps, "-o", o.output, "--format", o.format];
  if (!o.onFrames) args.push("--quiet");
  const { onFrames, onWait } = o;
  const onLine =
    onFrames || onWait
      ? (line: string) => {
          const f = onFrames && capturedFrames(line);
          if (f) onFrames(f.done, f.total);
          else if (onWait && waitsForRenderSlot(line)) onWait();
          o.onLine?.(line);
        }
      : o.onLine;
  const r = await runHyperframes(args, projectDir, onLine);
  // without --quiet the log is long: its end holds the failure
  if (r.code !== 0)
    throw new Error(`hyperframes render failed:\n${(r.stderr || r.stdout).slice(-4000)}`);
  return r;
}
