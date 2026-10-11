import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ffmpegPath, modelsDir, type Defaults } from "./config.js";
import { runHyperframes } from "./hyperframes.js";

export interface GpuStatus {
  mode: "hardware" | "software" | "unknown";
  renderer: string | null;
}

/** Reads the GPU line HyperFrames prints when it launches Chrome. */
export function parseGpuLine(output: string): GpuStatus {
  const m =
    /browserGpuMode probe\s*(?:→|->)\s*(hardware|software)(?:[^\n]*renderer="([^"]+)")?/.exec(
      output,
    );
  if (!m) return { mode: "unknown", renderer: null };
  return { mode: m[1] as "hardware" | "software", renderer: m[2] ?? null };
}

const PROBE_HTML = `<!doctype html>
<html><head><meta charset="UTF-8" /><script src="gsap.js"></script></head>
<body><div id="root" data-composition-id="probe" data-start="0" data-width="320" data-height="180" data-duration="0.2">
<canvas id="c" width="320" height="180"></canvas></div>
<script>window.__timelines["probe"] = gsap.timeline({ paused: true });</script></body></html>
`;

/**
 * Starts the bundled Chrome once through HyperFrames and reports whether WebGL runs on the GPU.
 * Software rendering is many times slower, so the companion warns about it.
 */
export async function probeGpu(gsapFile: string): Promise<GpuStatus> {
  const dir = mkdtempSync(join(tmpdir(), "mi-gpu-"));
  try {
    writeFileSync(join(dir, "index.html"), PROBE_HTML);
    copyFileSync(gsapFile, join(dir, "gsap.js"));
    const r = await runHyperframes(["check", "--no-contrast"], dir);
    return parseGpuLine(`${r.stdout}\n${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function ffmpegVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath(), ["-version"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    proc.stdout.on("data", (c: Buffer) => (out += c.toString()));
    proc.on("error", () => resolve(null));
    proc.on("close", (code) => resolve(code === 0 ? (out.split("\n")[0] ?? null) : null));
  });
}

/** True when the speech model has already been downloaded (first run downloads about 1 GB). */
export function speechModelCached(defaults: Defaults): boolean {
  return existsSync(join(modelsDir(), defaults.whisper.model, "onnx"));
}

export interface SystemReport {
  gpu: GpuStatus;
  ffmpeg: string | null;
  speechModel: { name: string; cached: boolean };
  platform: string;
}

export async function systemReport(defaults: Defaults, gsapFile: string): Promise<SystemReport> {
  const [gpu, ffmpeg] = await Promise.all([probeGpu(gsapFile), ffmpegVersion()]);
  return {
    gpu,
    ffmpeg,
    speechModel: { name: defaults.whisper.model, cached: speechModelCached(defaults) },
    platform: `${process.platform} ${process.arch}`,
  };
}
