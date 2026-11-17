import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/** Path to the pinned HyperFrames CLI (packages/core/package.json). */
export function hyperframesBin(): string {
  const pkgPath = require.resolve("hyperframes/package.json");
  const pkg = require(pkgPath) as { bin: Record<string, string> };
  return join(dirname(pkgPath), pkg.bin.hyperframes as string);
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
    const feed = (chunk: Buffer, sink: "out" | "err") => {
      arm();
      const text = chunk.toString();
      if (sink === "out") stdout += text;
      else stderr += text;
      if (!o.onLine) return;
      const lines = (pending[sink] + text).split("\n");
      pending[sink] = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) o.onLine(line);
    };
    proc.stdout.on("data", (c: Buffer) => feed(c, "out"));
    proc.stderr.on("data", (c: Buffer) => feed(c, "err"));
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
    env: {
      ...(o.env ?? process.env),
      HYPERFRAMES_NO_TELEMETRY: "1",
      DO_NOT_TRACK: "1",
      NO_COLOR: "1",
    },
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
  /** Which check pass reported it: lint, runtime, layout, motion or contrast. */
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

const SECTIONS = ["lint", "runtime", "layout", "motion", "contrast"] as const;

/**
 * Errors HyperFrames raises that are false alarms on our scenes, kept as warnings. canvas_covered takes the
 * usual background div under a WebGL canvas (lower z-index) for a cover over it.
 */
const DEMOTED = new Set(["canvas_covered"]);

/**
 * HyperFrames' words for a Chrome that could not start (puppeteer's launch error, its own system Chrome
 * fallback, a missing or unrunnable binary). Any other check_runtime_failure is an exception the page threw
 * (a goto timeout, a seek that throws, a crashed tab), which a scene can cause.
 */
const BROWSER_LAUNCH_FAILURE =
  /Failed to launch|System Chrome fallback|Could not find (Chrome|Chromium|browser)|Browser was not found|\bspawn\b|ENOENT|EACCES/i;

/** Parses `hyperframes check --json` output into errors and warnings across all sections. */
export function parseCheckJson(json: string): CheckReport {
  const start = json.indexOf("{");
  if (start < 0) throw new Error("hyperframes check did not return JSON.");
  const raw = JSON.parse(json.slice(start)) as Record<string, unknown>;
  return checkReport(raw);
}

function checkReport(raw: Record<string, unknown>): CheckReport {
  const errors: CheckFinding[] = [];
  const warnings: CheckFinding[] = [];
  let demoted = 0;
  for (const name of SECTIONS) {
    const section = raw[name] as CheckSection | undefined;
    for (const f of section?.findings ?? []) {
      if (f.severity === "error" && !DEMOTED.has(f.code ?? ""))
        errors.push({ ...f, section: name });
      else if (f.severity === "error") {
        demoted++;
        warnings.push({ ...f, severity: "warning", section: name });
      } else if (f.severity === "warning") warnings.push({ ...f, section: name });
    }
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
  // the browser is skipped on purpose when lint finds errors, and after a page that threw (its finding goes
  // to the scenes); with neither, it failed to start
  const environmentError = failed
    ? failed.message
    : raw.browserSkipped === true && !lintErrors && !pageFailed
      ? "The browser for the checks did not start."
      : null;
  // HyperFrames' own ok counts the errors we demoted
  const ok = errors.length === 0 && (raw.ok === true || demoted > 0);
  return { ok, errors, warnings, raw, environmentError };
}

/** The last lines of a process's output, for an error message. */
function tail(r: RunResult, chars = 2000): string {
  return (r.stderr.trim() || r.stdout.trim()).slice(-chars);
}

export async function checkProject(projectDir: string): Promise<CheckReport & { ms: number }> {
  const r = await runHyperframes(["check", "--json"], projectDir);
  try {
    return { ...parseCheckJson(r.stdout), ms: r.ms };
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
  if (r.code !== 0) throw new Error(`hyperframes snapshot failed:\n${tail(r, 4000)}`);
  // callers clear the folder first, so every numbered shot in it is this run's
  const byIndex = new Map<number, string>();
  for (const f of existsSync(outDir) ? readdirSync(outDir) : []) {
    const i = snapshotIndex(f);
    if (i !== null) byIndex.set(i, join(outDir, f));
  }
  const files = timesS.map((_, i) => byIndex.get(i));
  const missing = files.flatMap((f, i) => (f ? [] : [`${(timesS[i] as number).toFixed(2)} s`]));
  if (missing.length)
    throw new Error(
      `hyperframes snapshot wrote ${timesS.length - missing.length} of ${timesS.length} pictures (missing ${missing.join(", ")}).\n${tail(r)}`,
    );
  return { ...r, files: files as string[] };
}

export interface RenderOptions {
  fps: string;
  output: string;
  format: "mp4" | "mov";
  onLine?: (line: string) => void;
  /** Frames captured so far, from HyperFrames' progress lines. */
  onFrames?: (done: number, total: number) => void;
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
  // never --quiet: its progress lines are what tells the watchdog a long render is still alive
  const args = ["render", "--fps", o.fps, "-o", o.output, "--format", o.format];
  const onFrames = o.onFrames;
  const onLine = onFrames
    ? (line: string) => {
        const f = capturedFrames(line);
        if (f) onFrames(f.done, f.total);
        o.onLine?.(line);
      }
    : o.onLine;
  const r = await runHyperframes(args, projectDir, onLine);
  // without --quiet the log is long: its end holds the failure
  if (r.code !== 0)
    throw new Error(`hyperframes render failed:\n${(r.stderr || r.stdout).slice(-4000)}`);
  return r;
}
