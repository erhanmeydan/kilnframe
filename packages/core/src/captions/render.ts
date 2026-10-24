import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { formatFps, parseFps, renderFps } from "../fps.js";
import { compositeOver } from "../frames.js";
import { renderProject, snapshotProject } from "../hyperframes.js";
import { deliver } from "../stages/deliver.js";
import { buildCaptionProject, captionLines, type CaptionDoc } from "./compose.js";
import { toSrt } from "./srt.js";
import type { CaptionColors, CaptionStyleId } from "./types.js";

/** The number for the next captions-<n> files: one more than any already in the folder. */
export function nextCaptionNumber(outDir: string): number {
  if (!existsSync(outDir)) return 1;
  const used = readdirSync(outDir)
    .map((f) => /^captions-(\d+)\.(mov|srt)$/.exec(f)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);
  return used.length ? Math.max(...used) + 1 : 1;
}

export interface RenderCaptionsOptions {
  doc: CaptionDoc;
  look: CaptionStyleId;
  colors: CaptionColors;
  outDir: string;
  onProgress?: (message: string) => void;
}

/**
 * Renders the captions as a transparent ProRes 4444 clip at the sequence's size and rate, with an SRT of
 * the same lines. Each call writes new files (captions-1, captions-2, ...); earlier ones stay as they are.
 */
export async function renderCaptions(
  o: RenderCaptionsOptions,
): Promise<{ video: string; srt: string }> {
  // HyperFrames runs inside the project folder, so every path handed to it must be absolute
  const outDir = resolve(o.outDir);
  const log = o.onProgress ?? (() => {});
  mkdirSync(outDir, { recursive: true });
  const n = nextCaptionNumber(outDir);
  const projectDir = join(outDir, "captions-project");
  rmSync(projectDir, { recursive: true, force: true });
  log("Building the caption composition");
  buildCaptionProject(o.doc, o.look, o.colors, projectDir);

  log("Rendering captions");
  const master = join(projectDir, "renders", "master.mov");
  // non-standard sequence rates render at the nearest standard rate; delivery converts to the exact rate
  await renderProject(projectDir, {
    fps: formatFps(renderFps(parseFps(o.doc.fps))),
    output: master,
    format: "mov",
  });

  log("Encoding the caption clip");
  const video = join(outDir, `captions-${n}.mov`);
  await deliver({
    input: master,
    output: video,
    mode: "overlay",
    fps: o.doc.fps,
    width: o.doc.width,
    height: o.doc.height,
    handlesFrames: 0,
  });
  const srt = join(outDir, `captions-${n}.srt`);
  writeFileSync(srt, `${toSrt(captionLines(o.doc.lines))}\n`);
  return { video, srt };
}

export interface CaptionStillOptions {
  doc: CaptionDoc;
  look: CaptionStyleId;
  colors: CaptionColors;
  /** Seconds from the start of the doc. */
  atS: number;
  /** A frame of the footage to lay the captions over; transparent PNG when null. */
  frame: string | null;
  out: string;
}

/** One PNG of the captions at atS, over a frame of the footage when one is given. */
export async function previewCaptionStill(o: CaptionStillOptions): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "kilnframe-caption-still-"));
  try {
    buildCaptionProject(o.doc, o.look, o.colors, dir);
    const shots = join(dir, "shots");
    await snapshotProject(dir, [o.atS], shots);
    const shot = readdirSync(shots).find((f) => f.endsWith(".png"));
    if (!shot) throw new Error("HyperFrames did not write the caption still.");
    const out = resolve(o.out);
    mkdirSync(dirname(out), { recursive: true });
    if (o.frame) compositeOver(join(shots, shot), o.frame, out);
    else copyFileSync(join(shots, shot), out);
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
