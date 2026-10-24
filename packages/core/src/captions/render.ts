import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ffmpegPath } from "../config.js";
import { formatFps, parseFps, renderFps } from "../fps.js";
import { compositeOver } from "../frames.js";
import { renderProject, snapshotProject } from "../hyperframes.js";
import { deliver } from "../stages/deliver.js";
import {
  CAPTION_SEGMENT_S,
  buildCaptionProject,
  captionLines,
  captionSegments,
  type CaptionDoc,
} from "./compose.js";
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
  /** Where the doc starts in the sequence: the SRT counts from the sequence's start (0 unless given). */
  srtOffsetS?: number;
  /** Length of the pieces a long doc renders in (CAPTION_SEGMENT_S unless given). */
  segmentS?: number;
  onProgress?: (message: string) => void;
}

function joinPieces(pieces: string[], output: string, listFile: string): Promise<void> {
  // concat demuxer paths are quoted with single quotes; a quote inside is written '\''
  writeFileSync(
    listFile,
    pieces.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n",
  );
  return new Promise((resolve, reject) => {
    const args = [
      "-v",
      "error",
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listFile,
      "-c",
      "copy",
      output,
    ];
    const proc = spawn(ffmpegPath(), args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    proc.on("error", (err) => reject(new Error(`Could not start FFmpeg: ${err.message}`)));
    proc.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`FFmpeg could not join the caption pieces: ${stderr.trim()}`)),
    );
  });
}

/**
 * Renders the captions as a transparent ProRes 4444 clip at the sequence's size and rate, with an SRT of
 * the same lines. A long doc renders in segments (each its own project with only its lines), joined into
 * one clip without re-encoding. Each call writes new files (captions-1, captions-2, ...); earlier ones
 * stay as they are. The intermediate renders are removed once the clip is written.
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
  const segments = captionSegments(o.doc, o.segmentS ?? CAPTION_SEGMENT_S);
  const video = join(outDir, `captions-${n}.mov`);
  const pieces: string[] = [];
  try {
    for (const [k, segment] of segments.entries()) {
      const part = segments.length > 1 ? ` (part ${k + 1} of ${segments.length})` : "";
      const dir = segments.length > 1 ? join(projectDir, `part-${k + 1}`) : projectDir;
      log(`Building the caption composition${part}`);
      buildCaptionProject(o.doc, o.look, o.colors, dir, segment);
      log(`Rendering captions${part}`);
      const master = join(dir, "renders", "master.mov");
      // non-standard sequence rates render at the nearest standard rate; delivery converts to the exact rate
      await renderProject(dir, {
        fps: formatFps(renderFps(parseFps(o.doc.fps))),
        output: master,
        format: "mov",
      });
      log(`Encoding the caption clip${part}`);
      const piece = segments.length > 1 ? join(projectDir, `piece-${k + 1}.mov`) : video;
      await deliver({
        input: master,
        output: piece,
        mode: "overlay",
        fps: o.doc.fps,
        width: o.doc.width,
        height: o.doc.height,
        handlesFrames: 0,
      });
      rmSync(join(dir, "renders"), { recursive: true, force: true });
      if (piece !== video) pieces.push(piece);
    }
    if (pieces.length) {
      log("Joining the caption pieces");
      await joinPieces(pieces, video, join(projectDir, "pieces.txt"));
    }
  } finally {
    for (const piece of pieces) rmSync(piece, { force: true });
    rmSync(join(projectDir, "pieces.txt"), { force: true });
  }
  const srt = join(outDir, `captions-${n}.srt`);
  writeFileSync(srt, `${toSrt(captionLines(o.doc.lines), o.srtOffsetS ?? 0)}\n`);
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
