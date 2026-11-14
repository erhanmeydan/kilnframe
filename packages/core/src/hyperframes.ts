import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { framesToSeconds, parseFps } from "./fps.js";

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

export interface RunOptions {
  onLine?: ((line: string) => void) | undefined;
  /** Kill the process after this long without any output; a hung headless Chrome would hang the job. */
  idleTimeoutMs?: number | undefined;
  /** What the process is, for the timeout message ("hyperframes render"). */
  label?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

/** Ten minutes without a line: render prints progress all the way, check and snapshot end well within. */
export const HYPERFRAMES_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Runs a process, collecting its output and handing complete lines to onLine (a line split across two
 * chunks arrives whole). Rejects when the process stays silent for idleTimeoutMs.
 */
export function runProcess(
  command: string,
  args: string[],
  cwd: string,
  o: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const proc = spawn(command, args, {
      cwd,
      env: o.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const pending = { out: "", err: "" };
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const arm = () => {
      if (!o.idleTimeoutMs) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, o.idleTimeoutMs);
    };
    arm();
    const feed = (text: string, sink: "out" | "err") => {
      arm();
      if (sink === "out") stdout += text;
      else stderr += text;
      if (!o.onLine) return;
      const lines = (pending[sink] + text).split("\n");
      pending[sink] = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) o.onLine(line);
    };
    // decoded as a stream, so a Turkish letter split across two reads stays whole
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (c: string) => feed(c, "out"));
    proc.stderr.on("data", (c: string) => feed(c, "err"));
    proc.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      for (const rest of [pending.out, pending.err]) if (rest.trim()) o.onLine?.(rest);
      if (timedOut) {
        const tail = (stderr || stdout).trim().slice(-2000);
        const secs = Math.round((o.idleTimeoutMs ?? 0) / 1000);
        reject(
          new Error(
            `${o.label ?? command} stopped responding (no output for ${secs} s) and was stopped.${tail ? `\n${tail}` : ""}`,
          ),
        );
        return;
      }
      resolve({ code: code ?? 1, stdout, stderr, ms: Date.now() - started });
    });
  });
}

export function runHyperframes(
  args: string[],
  cwd: string,
  onLine?: (line: string) => void,
  o: { env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return runProcess(process.execPath, [hyperframesBin(), ...args], cwd, {
    onLine,
    idleTimeoutMs: HYPERFRAMES_IDLE_TIMEOUT_MS,
    label: `hyperframes ${args[0] ?? ""}`.trim(),
    env: hyperframesEnv(o.env ?? process.env),
  });
}

export interface CheckFinding {
  code?: string;
  severity: "error" | "warning" | "info";
  message: string;
  selector?: string;
  sourceFile?: string;
  time?: number;
  /** Where on the frame, in the composition's pixels (layout findings). */
  rect?: { left: number; top: number; width: number; height: number };
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
  /**
   * The check itself could not run (Chrome did not start, the linter crashed): a problem of the
   * machine, not of any scene, so no model is asked to repair it.
   */
  environmentError: string | null;
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
 * Which of sceneIds a finding is placed in by its file (compositions/<id>.html) or its selector (#<id>-…, a class
 * .<id>-…, which HyperFrames names an element by when it has no id, or the scene's [data-composition-id]), else null.
 */
export function sceneOfFinding(f: CheckFinding, sceneIds: string[]): string | null {
  for (const id of sceneIds) {
    if (f.sourceFile?.includes(`compositions/${id}.html`)) return id;
    if (f.selector && new RegExp(`[#.]${id}-|\\[data-composition-id="${id}"\\]`).test(f.selector))
      return id;
  }
  return null;
}

/** A selector HyperFrames builds as a path from a scene's root (#root, the id the compose prompt gives it). */
const UNDER_ROOT = /^#root(?![\w-])/;

/**
 * The scene on screen at a finding's time, from the plan in projectDir: for a selector that names the scene only by
 * its root (#root > div:nth-of-type(2)). Null without a time or a plan, or when no scene or more than one is.
 */
function sceneAtTime(projectDir: string, f: CheckFinding): string | null {
  if (f.time === undefined || !UNDER_ROOT.test(f.selector ?? "")) return null;
  let plan: { fps: string; scenes: { id: string; start_frame: number; end_frame: number }[] };
  try {
    plan = JSON.parse(readFileSync(join(projectDir, "plan.json"), "utf8")) as typeof plan;
  } catch {
    return null;
  }
  const fps = parseFps(plan.fps);
  const on = plan.scenes.filter(
    (s) =>
      framesToSeconds(s.start_frame, fps) <= (f.time as number) &&
      (f.time as number) < framesToSeconds(s.end_frame, fps),
  );
  return on.length === 1 ? (on[0] as { id: string }).id : null;
}

/**
 * For a finding of a check of projectDir: whether its scene (sceneOfFinding, over the project's compositions, else
 * sceneAtTime for a path under #root) draws on a canvas. The root page and a scene not found say no.
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
    const id = sceneOfFinding(f, ids) ?? sceneAtTime(projectDir, f);
    if (id === null || !ids.includes(id)) return false;
    try {
      return DRAWS_ON_CANVAS.test(readFileSync(join(scenes, `${id}.html`), "utf8"));
    } catch {
      return false;
    }
  };
}

/** The error the app gives a check, or a pass of it, that failed without listing why: a timeout, a budget cut short. */
const UNEXPLAINED = "The check failed without saying why.";
const UNEXPLAINED_CODE = "check_unexplained";

/**
 * Whether a finding is the app's own for a check that failed without listing why: nothing in a scene to repair, so
 * the repair loop checks again instead of sending it to the scenes.
 */
export function isUnexplained(f: CheckFinding): boolean {
  return f.code === UNEXPLAINED_CODE;
}

/**
 * HyperFrames' words for a Chrome that could not start (puppeteer's launch error, its own system Chrome
 * fallback, a missing or unrunnable binary). Any other check_runtime_failure is an exception the page threw
 * (a goto timeout, a seek that throws, a crashed tab), which a scene can cause.
 */
const BROWSER_LAUNCH_FAILURE =
  /Failed to launch|System Chrome fallback|Could not find (Chrome|Chromium|browser)|Browser was not found|\bspawn\b|ENOENT|EACCES/i;

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
  return checkReport(raw, onCanvas);
}

function checkReport(raw: Record<string, unknown>, onCanvas: InCanvasScene): CheckReport {
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
  // the linter crashing is never a scene's doing; a runtime failure is the machine's only when Chrome
  // did not start
  const failed = errors.find(
    (e) =>
      e.code === "check_lint_failure" ||
      (e.code === "check_runtime_failure" && BROWSER_LAUNCH_FAILURE.test(e.message)),
  );
  const pageFailed = errors.some((e) => e.code === "check_runtime_failure");
  const lintErrors = errors.some((e) => e.section === "lint");
  if (raw.browserSkipped === true) {
    errors.push({
      code: "check_browser_skipped",
      severity: "error",
      message: "The browser checks did not run (layout, motion, contrast).",
    });
  }
  if (raw.ok !== true && errors.length === 0) {
    const finding = { code: UNEXPLAINED_CODE, severity: "error", message: UNEXPLAINED } as const;
    for (const section of unexplained) errors.push({ ...finding, section });
    if (!unexplained.length && !explained) errors.push({ ...finding });
  }
  // the browser is skipped on purpose when lint finds errors, and after a page that threw (its finding goes
  // to the scenes); with neither, it failed to start
  const environmentError = failed
    ? failed.message
    : raw.browserSkipped === true && !lintErrors && !pageFailed
      ? "The browser for the checks did not start."
      : null;
  return { ok: errors.length === 0, errors, warnings, raw, environmentError };
}

/** The last lines of a process's output, for an error message. */
function tail(r: RunResult, chars = 2000): string {
  return (r.stderr.trim() || r.stdout.trim()).slice(-chars);
}

export async function checkProject(projectDir: string): Promise<CheckReport & { ms: number }> {
  const r = await runHyperframes(["check", "--json"], projectDir);
  try {
    return { ...parseCheckJson(r.stdout, inCanvasScene(projectDir)), ms: r.ms };
  } catch (err) {
    // no report at all: say why, rather than "did not return JSON"
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(`hyperframes check failed (exit code ${r.code}): ${why}\n${tail(r)}`, {
      cause: err,
    });
  }
}

/** frame-03-at-1.25s.png → 3: HyperFrames numbers the shots in the order of the --at times. */
export function snapshotIndex(file: string): number | null {
  const m = /^frame-(\d+)-at-.*\.png$/.exec(file);
  return m ? Number(m[1]) : null;
}

/**
 * One PNG per time, in the order given (files[i] is timesS[i]). Shots are matched by the index in their
 * name, and a missing one throws: matched by position, one shot fewer would hand every later scene its
 * neighbour's picture.
 */
export async function snapshotProject(
  projectDir: string,
  timesS: number[],
  outDir: string,
): Promise<RunResult & { files: string[] }> {
  const at = timesS.map((t) => t.toFixed(3)).join(",");
  // with GEMINI_API_KEY set, HyperFrames would send every shot to Gemini for a description we never read
  const r = await runHyperframes(
    ["snapshot", "--at", at, "--no-end", "--describe", "false", "-o", outDir],
    projectDir,
  );
  if (r.code !== 0) throw new Error(`hyperframes snapshot failed:\n${failureOutput(r)}`);
  const dir = resolve(projectDir, outDir);
  // fewer stills than times, or none under a naming this does not know, says what the folder holds
  const stills = stillsTaken(dir, timesS.length);
  // callers clear the folder first, so every numbered shot in it is this run's
  const byIndex = new Map<number, string>();
  for (const f of existsSync(dir) ? readdirSync(dir) : []) {
    const i = snapshotIndex(f);
    if (i !== null) byIndex.set(i, join(dir, f));
  }
  const files = byIndex.size
    ? timesS.map((_, i) => byIndex.get(i))
    : stills.slice(0, timesS.length);
  const missing = files.flatMap((f, i) => (f ? [] : [`${(timesS[i] as number).toFixed(2)} s`]));
  if (missing.length)
    throw new Error(
      `hyperframes snapshot wrote ${timesS.length - missing.length} of ${timesS.length} pictures (missing ${missing.join(", ")}).\n${tail(r)}`,
    );
  return { ...r, files: files as string[] };
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
  /** Frames captured so far, from HyperFrames' progress lines. */
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

/** Lines that say why a run failed: a crash prints its reason once, before a native stack far longer than it. */
const CAUSE_LINE =
  /\b(error|fatal|failed|failure|exception|abort(ed)?|out of memory|heap|killed|signal|cannot|unable)\b/i;
/** Lines that only tell how far a run got. */
const PROGRESS_LINE = /^(@hf-progress |\[INFO\]|\[static-dedup\])/;

/**
 * A failed run's output for its error, at most about `chars` long: all of it when it fits, else the lines before the
 * end that name a failure (the head, earliest first) and then the end, so the cause is kept when a long stack follows.
 */
export function failureOutput(r: RunResult, chars = 4000): string {
  const all = r.stderr.trim() || r.stdout.trim();
  if (all.length <= chars) return all;
  const end = all.slice(-Math.floor(chars / 2));
  const before = all.slice(0, all.length - end.length);
  let head = "";
  for (const line of before.split("\n")) {
    const l = line.trim();
    if (!l || PROGRESS_LINE.test(l) || !CAUSE_LINE.test(l)) continue;
    const next = head ? `${head}\n${l}` : l;
    if (next.length > chars - end.length - 2) break;
    head = next;
  }
  const rest = all.slice(-(chars - head.length - 2));
  return head ? `${head}\n…\n${rest.slice(rest.indexOf("\n") + 1)}` : all.slice(-chars);
}

export async function renderProject(projectDir: string, o: RenderOptions): Promise<RunResult> {
  // never --quiet: its progress lines are what tells the watchdog a long render is still alive
  const args = ["render", "--fps", o.fps, "-o", o.output, "--format", o.format];
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
  // without --quiet the log is long: its end holds the failure, or a crash's stack with the cause before it
  if (r.code !== 0) throw new Error(`hyperframes render failed:\n${failureOutput(r)}`);
  return r;
}
