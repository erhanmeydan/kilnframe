import { spawn } from "node:child_process";
import { ffmpegPath } from "../config.js";
import { formatFps, parseFps } from "../fps.js";
import type { OutputMode } from "../schemas/plan.js";

export interface DeliverOptions {
  input: string;
  output: string;
  mode: OutputMode;
  fps: string;
  width: number;
  height: number;
  /** Frames of frozen first/last image added before and after the body (edit handles). */
  handlesFrames: number;
}

/** Target H.264 bitrate in Mbit/s: about 20 for 1080p, scaled by pixel count, capped for 4K. */
export function targetMbps(width: number, height: number): number {
  const scale = (width * height) / (1920 * 1080);
  return Math.min(80, Math.max(8, Math.round(20 * scale)));
}

/** FFmpeg arguments for the delivery file. Pure, so the encoding contract is testable. */
export function deliverArgs(o: DeliverOptions): string[] {
  const fps = formatFps(parseFps(o.fps));
  const pad =
    o.handlesFrames > 0
      ? `tpad=start=${o.handlesFrames}:stop=${o.handlesFrames}:start_mode=clone:stop_mode=clone,`
      : "";
  const base = ["-v", "error", "-y", "-i", o.input, "-an", "-r", fps];
  if (o.mode === "overlay") {
    return [
      ...base,
      "-vf",
      `${pad}format=yuva444p10le`,
      "-c:v",
      "prores_ks",
      "-profile:v",
      "4",
      "-vendor",
      "apl0",
      "-pix_fmt",
      "yuva444p10le",
      o.output,
    ];
  }
  const mbps = targetMbps(o.width, o.height);
  return [
    ...base,
    "-vf",
    `${pad}format=yuv420p`,
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-profile:v",
    "high",
    "-b:v",
    `${mbps}M`,
    "-maxrate",
    `${Math.round(mbps * 1.5)}M`,
    "-bufsize",
    `${mbps * 2}M`,
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    o.output,
  ];
}

export interface PreviewOptions {
  video: string;
  speech: string;
  sfx: string;
  output: string;
  fps: string;
  handlesFrames: number;
  /** A frame of the footage to show under an insert with alpha (.mov); black when there is none. */
  backdrop?: string | undefined;
  /** The range's own picture (the panel exports it from the sequence); preferred over the frame. */
  footage?: string | undefined;
}

/**
 * Preview for judging the result: the delivered video with the original speech (delayed by the handle)
 * and the effects mix underneath, as the editor will hear it on the timeline.
 */
export function previewArgs(o: PreviewOptions): string[] {
  const delayMs = Math.round(
    ((o.handlesFrames * parseFps(o.fps).den) / parseFps(o.fps).num) * 1000,
  );
  const audio = `[1:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay=${delayMs}|${delayMs}[sp];[sp][2:a]amix=inputs=2:normalize=0:duration=longest[a]`;
  // ProRes 4444 with alpha cannot go into an MP4: the preview lays it over the footage (or black) as H.264
  const alpha = o.video.toLowerCase().endsWith(".mov");
  const handleS = (o.handlesFrames * parseFps(o.fps).den) / parseFps(o.fps).num;
  const backdrop = alpha
    ? o.footage
      ? ["-i", o.footage]
      : o.backdrop
        ? ["-loop", "1", "-i", o.backdrop]
        : ["-f", "lavfi", "-i", "color=c=black:s=16x16"]
    : [];
  // the footage covers the range only: its first and last frames hold over the insert's handles
  const ground = o.footage
    ? `[3:v]tpad=start_duration=${handleS.toFixed(3)}:start_mode=clone:stop_duration=${(handleS + 1).toFixed(3)}:stop_mode=clone[ft];[ft]`
    : "[3:v]";
  return [
    "-v",
    "error",
    "-y",
    "-i",
    o.video,
    "-i",
    o.speech,
    "-i",
    o.sfx,
    ...backdrop,
    "-filter_complex",
    alpha
      ? `${ground}[0:v]scale2ref[bg][fg];[bg][fg]overlay=shortest=1:format=auto,format=yuv420p[v];${audio}`
      : audio,
    "-map",
    alpha ? "[v]" : "0:v",
    "-map",
    "[a]",
    ...(alpha ? ["-c:v", "libx264", "-crf", "20", "-preset", "medium"] : ["-c:v", "copy"]),
    "-c:a",
    "aac",
    "-b:a",
    "256k",
    "-shortest",
    "-movflags",
    "+faststart",
    o.output,
  ];
}

export function buildPreview(o: PreviewOptions): Promise<void> {
  return runFfmpeg(previewArgs(o), "the preview");
}

export function deliver(o: DeliverOptions): Promise<void> {
  return runFfmpeg(deliverArgs(o), "the delivery file");
}

function runFfmpeg(args: string[], what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath(), args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    proc.on("error", (err) =>
      reject(new Error(`Could not start FFmpeg (${ffmpegPath()}): ${err.message}`)),
    );
    proc.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`FFmpeg could not encode ${what}: ${stderr.trim()}`)),
    );
  });
}
