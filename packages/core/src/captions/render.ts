import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ffmpegPath } from "../config.js";
import { formatFps, parseFps, renderFps, type Fps } from "../fps.js";
import { compositeOver } from "../frames.js";
import { renderProject, snapshotProject } from "../hyperframes.js";
import {
  CAPTION_SEGMENT_S,
  buildCaptionProject,
  captionLines,
  captionScript,
  captionSegments,
  type CaptionDoc,
  type CaptionSegment,
} from "./compose.js";
import { framePlan, timelineSpans, type FramePlan } from "./frames.js";
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
 * The frames to draw for a segment: only those that can differ from the one before (frames.ts). A
 * timeline the reader cannot follow draws every frame, as before.
 */
export function captionFramePlan(
  o: Pick<RenderCaptionsOptions, "doc" | "look" | "colors">,
  segment: CaptionSegment,
  rate: Fps,
): FramePlan {
  const durationS = segment.endS - segment.startS;
  try {
    return framePlan(
      timelineSpans(captionScript(o.doc, o.look, o.colors, segment)),
      durationS,
      rate,
    );
  } catch {
    const all = [{ startS: 0, endS: durationS }];
    return framePlan(all, durationS, rate);
  }
}

/**
 * The clip's frames as one numbered sequence (pattern for FFmpeg): frame f is a link to the drawn PNG it
 * shows. Hard links beside the PNGs; where the disk has none (exFAT), symbolic links in the temp folder;
 * where neither works, copies.
 */
export function frameSequence(
  framesDir: string,
  plan: FramePlan,
): { pattern: string; dispose: () => void } {
  const drawn = readdirSync(framesDir)
    .filter((f) => /\.png$/i.test(f))
    .sort();
  if (drawn.length < plan.times.length)
    throw new Error(
      `HyperFrames drew ${drawn.length} caption frames, ${plan.times.length} were expected.`,
    );
  const name = (f: number) => `${String(f).padStart(7, "0")}.png`;
  const tries: { dir: string; link: (from: string, to: string) => void }[] = [
    { dir: join(framesDir, "..", "sequence"), link: (from, to) => linkSync(from, to) },
    {
      dir: join(tmpdir(), `kilnframe-caption-seq-${process.pid}-${Date.now()}`),
      link: (from, to) => symlinkSync(from, to),
    },
    { dir: join(framesDir, "..", "sequence"), link: (from, to) => copyFileSync(from, to) },
  ];
  let last: unknown;
  for (const { dir, link } of tries) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    try {
      plan.sourceOf.forEach((k, f) =>
        link(resolve(framesDir, drawn[k] as string), join(dir, name(f))),
      );
      return {
        pattern: join(dir, "%07d.png"),
        dispose: () => rmSync(dir, { recursive: true, force: true }),
      };
    } catch (err) {
      last = err;
      rmSync(dir, { recursive: true, force: true });
    }
  }
  throw new Error(
    `Could not lay out the caption frames: ${last instanceof Error ? last.message : String(last)}`,
  );
}

/** Encoders for the transparent clip, best first: Apple's own ProRes on a Mac, then FFmpeg's. */
export function proresEncoders(platform: NodeJS.Platform = process.platform): string[][] {
  const ks = [
    "-c:v",
    "prores_ks",
    "-profile:v",
    "4",
    "-vendor",
    "apl0",
    "-pix_fmt",
    "yuva444p10le",
  ];
  const vt = ["-c:v", "prores_videotoolbox", "-profile:v", "4444", "-pix_fmt", "ayuv64le"];
  return platform === "darwin" ? [vt, ks] : [ks];
}

/** FFmpeg arguments that encode a PNG sequence drawn at inputFps into a ProRes 4444 clip at fps. */
export function encodeArgs(
  pattern: string,
  inputFps: Fps,
  fps: string,
  output: string,
  encoder: string[],
): string[] {
  return [
    "-v",
    "error",
    "-y",
    "-framerate",
    formatFps(inputFps),
    "-i",
    pattern,
    "-an",
    "-r",
    formatFps(parseFps(fps)),
    ...encoder,
    output,
  ];
}

/** Runs FFmpeg; onFrame hears the number of frames written so far (its -progress lines). */
function runFfmpeg(args: string[], onFrame?: (frames: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const withProgress = onFrame ? ["-progress", "pipe:1", "-nostats", ...args] : args;
    const proc = spawn(ffmpegPath(), withProgress, { stdio: ["ignore", "pipe", "pipe"] });
    let rest = "";
    proc.stdout.on("data", (c: Buffer) => {
      const lines = (rest + c.toString()).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) {
        const m = /^frame=(\d+)/.exec(line);
        if (m && onFrame) onFrame(Number(m[1]));
      }
    });
    let stderr = "";
    proc.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    proc.on("error", (err) => reject(new Error(`Could not start FFmpeg: ${err.message}`)));
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(stderr.trim().slice(-2000) || `exit code ${code}`)),
    );
  });
}

/** Encodes the sequence with the first encoder that works; the last failure is the one reported. */
async function encodeFrames(
  pattern: string,
  inputFps: Fps,
  fps: string,
  output: string,
  onFrame?: (frames: number) => void,
): Promise<void> {
  let last: unknown;
  for (const encoder of proresEncoders()) {
    try {
      await runFfmpeg(encodeArgs(pattern, inputFps, fps, output, encoder), onFrame);
      return;
    } catch (err) {
      last = err;
      rmSync(output, { force: true });
    }
  }
  throw new Error(
    `FFmpeg could not encode the caption clip: ${last instanceof Error ? last.message : String(last)}`,
  );
}

/** The share of a piece's time spent drawing its frames; the rest is the encode (measured on a Mac). */
const DRAW_SHARE = 0.3;

/**
 * One percentage for the whole clip: each piece weighs by its length, drawing and encoding inside it by
 * DRAW_SHARE. Says "Rendering captions: N%" only when N moves.
 */
export function captionProgress(
  segments: { startS: number; endS: number }[],
  log: (message: string) => void,
): (piece: number, stage: "draw" | "encode", fraction: number) => void {
  const total = segments.reduce((sum, s) => sum + (s.endS - s.startS), 0) || 1;
  let shown = -1;
  return (piece, stage, fraction) => {
    const before = segments.slice(0, piece).reduce((sum, s) => sum + (s.endS - s.startS), 0);
    const seg = segments[piece] as { startS: number; endS: number };
    const f = Math.min(1, Math.max(0, fraction));
    const within = stage === "draw" ? DRAW_SHARE * f : DRAW_SHARE + (1 - DRAW_SHARE) * f;
    const pct = Math.min(
      100,
      Math.floor(((before + within * (seg.endS - seg.startS)) / total) * 100),
    );
    if (pct <= shown) return;
    shown = pct;
    log(`Rendering captions: ${pct}%`);
  };
}

/**
 * Renders the captions as a transparent ProRes 4444 clip at the sequence's size and rate, with an SRT of
 * the same lines. A long doc renders in segments (each its own project with only its lines), joined into
 * one clip without re-encoding. Each call writes new files (captions-1, captions-2, ...); earlier ones
 * stay as they are. The intermediate renders are removed once the clip is written. Only the frames that
 * can change are drawn (captionFramePlan); the others repeat the picture before them in the encode.
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
    const progress = captionProgress(segments, log);
    progress(0, "draw", 0);
    for (const [k, segment] of segments.entries()) {
      const dir = segments.length > 1 ? join(projectDir, `part-${k + 1}`) : projectDir;
      // non-standard sequence rates render at the nearest standard rate; the encode converts to the exact rate
      const rate = renderFps(parseFps(o.doc.fps));
      const plan = captionFramePlan(o, segment, rate);
      buildCaptionProject(o.doc, o.look, o.colors, dir, segment, { times: plan.times, fps: rate });
      const framesDir = join(dir, "renders", "frames");
      // a long piece takes minutes: its share of frames tells the editor it is moving
      await renderProject(dir, {
        fps: formatFps(rate),
        output: framesDir,
        format: "png-sequence",
        onFrames: (done, total) => progress(k, "draw", total > 0 ? done / total : 0),
      });
      const piece = segments.length > 1 ? join(projectDir, `piece-${k + 1}.mov`) : video;
      const sequence = frameSequence(framesDir, plan);
      const frames = plan.sourceOf.length;
      try {
        await encodeFrames(sequence.pattern, rate, o.doc.fps, piece, (done) =>
          progress(k, "encode", done / frames),
        );
      } finally {
        sequence.dispose();
      }
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
