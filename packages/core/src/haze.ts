import { spawnSync } from "node:child_process";
import { closeSync, openSync, readdirSync, readSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ffmpegPath } from "./config.js";
import { snapshotProject, type CheckFinding } from "./hyperframes.js";
import { sceneMode, type Plan } from "./schemas/plan.js";

/** Alpha at or below this (8%) is nearly invisible over the footage but still tints it once graded. */
const FAINT_ALPHA = 20;
/** Share of the frame that may be faint: shape edges stay well under it (about 2% measured). */
const MAX_FAINT_SHARE = 0.03;

/** The grid a still is averaged into before counting: enough for areas and quick. */
const GRID_W = 480;
const GRID_H = 270;

/**
 * Share of a transparent still's pixels that are faintly covered (0 < alpha <= 8%). An overlay should leave
 * the frame either clear or visibly covered; a faint layer over a wide area reads as haze over the speaker.
 * FFmpeg only extracts the alpha at full size; the averaging is done here, because FFmpeg's Windows build
 * read clear pixels as 1 whenever the size did not divide evenly (a portrait 2160x3840 overlay, 31 Oct 2026).
 */
export function faintShare(png: string): number {
  const size = pngSize(png);
  if (!size) return 0;
  const r = spawnSync(
    ffmpegPath(),
    ["-v", "error", "-i", png, "-vf", "alphaextract", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
    { maxBuffer: size.width * size.height + (1 << 16) },
  );
  if (r.status !== 0 || r.stdout.length !== size.width * size.height) return 0; // no alpha channel
  return faintShareOf(r.stdout, size.width, size.height);
}

/** faintShare on a full-size alpha plane: each grid cell is the plain average of the pixels it covers. */
export function faintShareOf(alpha: Uint8Array, width: number, height: number): number {
  const sums = new Float64Array(GRID_W * GRID_H);
  const counts = new Uint32Array(GRID_W * GRID_H);
  const col = new Uint32Array(width);
  for (let x = 0; x < width; x++) col[x] = Math.floor((x * GRID_W) / width);
  for (let y = 0; y < height; y++) {
    const row = Math.floor((y * GRID_H) / height) * GRID_W;
    for (let x = 0; x < width; x++) {
      const cell = row + (col[x] as number);
      sums[cell] = (sums[cell] as number) + (alpha[y * width + x] as number);
      counts[cell] = (counts[cell] as number) + 1;
    }
  }
  let faint = 0;
  let cells = 0;
  for (let i = 0; i < sums.length; i++) {
    const n = counts[i] as number;
    if (!n) continue; // a still smaller than the grid leaves cells empty
    cells++;
    const a = Math.round((sums[i] as number) / n);
    if (a > 0 && a <= FAINT_ALPHA) faint++;
  }
  return cells ? faint / cells : 0;
}

/** Width and height from a PNG's header, or null when the file is not a PNG. */
function pngSize(png: string): { width: number; height: number } | null {
  const head = Buffer.alloc(24);
  const fd = openSync(png, "r");
  try {
    readSync(fd, head, 0, 24, 0);
  } finally {
    closeSync(fd);
  }
  if (head.readUInt32BE(12) !== 0x49484452) return null; // "IHDR"
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

/**
 * Renders each overlay scene at the given times (the still times) and reports the ones that lay a faint
 * layer over a wide part of the frame: a grain or paper texture over everything (9 Oct 2026, 85% of the
 * frame at about 2% alpha) or a nearly invisible card (a 2.5% panel over 9%). The HTML check catches the
 * usual cause (feTurbulence, grain); this one looks at the pixels, whatever made them.
 */
export async function overlayHazeFindings(
  plan: Plan,
  projectDir: string,
  times: number[],
  workDir: string,
): Promise<CheckFinding[]> {
  const overlay = plan.scenes
    .map((s, i) => ({ s, at: times[i] as number }))
    .filter(({ s }) => sceneMode(plan, s) === "overlay");
  if (!overlay.length) return [];
  rmSync(workDir, { recursive: true, force: true });
  await snapshotProject(
    projectDir,
    overlay.map((o) => o.at),
    workDir,
  );
  const shots = readdirSync(workDir)
    .filter((f) => /^frame-\d+.*\.png$/.test(f))
    .sort();
  const findings: CheckFinding[] = [];
  overlay.forEach(({ s, at }, i) => {
    const shot = shots[i];
    if (!shot) return;
    const share = faintShare(join(workDir, shot));
    if (share <= MAX_FAINT_SHARE) return;
    findings.push({
      code: "overlay_faint_layer",
      severity: "error",
      section: "pixels",
      selector: `[data-composition-id="${s.id}"]`,
      time: at,
      message: `Overlay scene ${s.id}: ${Math.round(share * 100)}% of the frame is covered by an almost invisible layer (alpha 8% or less) at ${at.toFixed(2)} s. Over the footage it shows as a haze or a ghost panel on the speaker.`,
      fixHint:
        "Remove the faint layer (grain, noise, paper texture, a near-transparent card or wash). Every element in an overlay is either clearly visible or absent; the rest of the frame stays fully transparent.",
    });
  });
  return findings;
}
