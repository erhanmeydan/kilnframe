import { spawn } from "node:child_process";
import { createRequire } from "node:module";
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

export function runHyperframes(
  args: string[],
  cwd: string,
  onLine?: (line: string) => void,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const proc = spawn(process.execPath, [hyperframesBin(), ...args], {
      cwd,
      env: { ...process.env, HYPERFRAMES_NO_TELEMETRY: "1", DO_NOT_TRACK: "1", NO_COLOR: "1" },
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
}

const SECTIONS = ["lint", "runtime", "layout", "motion", "contrast"] as const;

/** Parses `hyperframes check --json` output into errors and warnings across all sections. */
export function parseCheckJson(json: string): CheckReport {
  const start = json.indexOf("{");
  if (start < 0) throw new Error("hyperframes check did not return JSON.");
  const raw = JSON.parse(json.slice(start)) as Record<string, unknown>;
  const errors: CheckFinding[] = [];
  const warnings: CheckFinding[] = [];
  for (const name of SECTIONS) {
    const section = raw[name] as CheckSection | undefined;
    for (const f of section?.findings ?? []) {
      if (f.severity === "error") errors.push({ ...f, section: name });
      else if (f.severity === "warning") warnings.push({ ...f, section: name });
    }
  }
  if (raw.browserSkipped === true) {
    errors.push({
      severity: "error",
      message: "The browser checks did not run (layout, motion, contrast).",
    });
  }
  return { ok: raw.ok === true && errors.length === 0, errors, warnings, raw };
}

export async function checkProject(projectDir: string): Promise<CheckReport & { ms: number }> {
  const r = await runHyperframes(["check", "--json"], projectDir);
  return { ...parseCheckJson(r.stdout), ms: r.ms };
}

export async function snapshotProject(
  projectDir: string,
  timesS: number[],
  outDir: string,
): Promise<RunResult> {
  const at = timesS.map((t) => t.toFixed(3)).join(",");
  const r = await runHyperframes(["snapshot", "--at", at, "--no-end", "-o", outDir], projectDir);
  if (r.code !== 0) throw new Error(`hyperframes snapshot failed:\n${r.stderr || r.stdout}`);
  return r;
}

export interface RenderOptions {
  fps: string;
  output: string;
  format: "mp4" | "mov";
  onLine?: (line: string) => void;
  /** Frames captured so far: given, the render runs without --quiet so HyperFrames reports them. */
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
  const args = ["render", "--fps", o.fps, "-o", o.output, "--format", o.format];
  if (!o.onFrames) args.push("--quiet");
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
