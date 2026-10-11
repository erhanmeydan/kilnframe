import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { ffmpegPath } from "./config.js";

/**
 * Frames of the footage under the range (the panel exports them from the sequence). The plan step looks at
 * them to choose fullscreen or overlay per scene and to find where the speaker sits; the review shows overlay
 * scenes over them, so the editor sees whether a graphic covers the face before the render.
 */
export interface FrameInput {
  path: string;
  /** Seconds from the start of the range. */
  atS: number;
}

export interface RangeFrame {
  atS: number;
  /** The full-size copy in <outDir>/frames. */
  file: string;
  /** Small JPEG for the model. */
  preview: { mediaType: "image/jpeg"; base64: string };
}

/** "frame.png@2.5" from the command line. */
export function parseFrameArg(arg: string): FrameInput {
  const at = arg.lastIndexOf("@");
  const atS = Number(arg.slice(at + 1));
  if (at < 1 || !Number.isFinite(atS) || atS < 0)
    throw new Error(`--frame takes <file>@<seconds from the range start>, got "${arg}".`);
  return { path: arg.slice(0, at), atS };
}

function framesDir(outDir: string): string {
  return join(outDir, "frames");
}

function previewOf(file: string, out: string): void {
  const r = spawnSync(ffmpegPath(), [
    "-v",
    "error",
    "-y",
    "-i",
    file,
    "-vf",
    "scale='min(1024,iw)':-2",
    "-q:v",
    "4",
    out,
  ]);
  if (r.status !== 0) throw new Error(`could not read the frame ${file}`);
}

/**
 * Copies the frames into <outDir>/frames as f1.png..., makes previews and writes frames.json. Frames are
 * optional help: one that is missing is left out instead of stopping the job.
 */
export function prepareFrames(inputs: FrameInput[], outDir: string): RangeFrame[] {
  const sorted = inputs.filter((f) => existsSync(f.path)).sort((a, b) => a.atS - b.atS);
  if (!sorted.length) return [];
  const dir = framesDir(outDir);
  mkdirSync(dir, { recursive: true });
  const list = sorted.map((f, i) => {
    const name = `f${i + 1}${extname(f.path).toLowerCase() || ".png"}`;
    const file = join(dir, name);
    if (f.path !== file) copyFileSync(f.path, file);
    previewOf(file, join(dir, `f${i + 1}-preview.jpg`));
    return { atS: f.atS, name };
  });
  writeFileSync(join(dir, "frames.json"), `${JSON.stringify(list, null, 2)}\n`);
  return readFrames(outDir);
}

/** The frames a job prepared earlier (the review stage renders again from the job folder). */
export function readFrames(outDir: string): RangeFrame[] {
  const dir = framesDir(outDir);
  const index = join(dir, "frames.json");
  if (!existsSync(index)) return [];
  const list = JSON.parse(readFileSync(index, "utf8")) as { atS: number; name: string }[];
  return list.map((f, i) => ({
    atS: f.atS,
    file: join(dir, f.name),
    preview: {
      mediaType: "image/jpeg" as const,
      base64: readFileSync(join(dir, `f${i + 1}-preview.jpg`)).toString("base64"),
    },
  }));
}

export function nearestFrame(frames: RangeFrame[], atS: number): RangeFrame | null {
  let best: RangeFrame | null = null;
  for (const f of frames) if (!best || Math.abs(f.atS - atS) < Math.abs(best.atS - atS)) best = f;
  return best;
}

/** Lays a transparent still over a frame of the footage, both scaled to the still's size. */
export function compositeOver(still: string, frame: string, out: string): void {
  const r = spawnSync(ffmpegPath(), [
    "-v",
    "error",
    "-y",
    "-i",
    still,
    "-i",
    frame,
    "-filter_complex",
    "[1:v][0:v]scale2ref[bg][fg];[bg][fg]overlay=format=auto",
    "-frames:v",
    "1",
    out,
  ]);
  if (r.status !== 0) throw new Error(`could not lay ${still} over the footage`);
}
