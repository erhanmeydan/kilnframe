import { spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ffmpegPath } from "./config.js";
import { snapshotProject, type CheckFinding } from "./hyperframes.js";
import { sceneMode, type Plan } from "./schemas/plan.js";

/** Alpha at or below this (8%) is nearly invisible over the footage but still tints it once graded. */
const FAINT_ALPHA = 20;
/** Share of the frame that may be faint: shape edges stay well under it (about 2% measured). */
const MAX_FAINT_SHARE = 0.03;

/**
 * Share of a transparent still's pixels that are faintly covered (0 < alpha <= 8%). An overlay should leave
 * the frame either clear or visibly covered; a faint layer over a wide area reads as haze over the speaker.
 * Measured at 480x270, which is enough for areas and quick.
 */
export function faintShare(png: string): number {
  const r = spawnSync(
    ffmpegPath(),
    [
      "-v",
      "error",
      "-i",
      png,
      "-vf",
      // area: a plain average. The default (bicubic) turns transparent pixels into 1 in the Windows build
      // of FFmpeg, so a clean overlay read as a faint layer over the whole frame
      "alphaextract,scale=480:270:flags=area",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "-",
    ],
    { maxBuffer: 1 << 24 },
  );
  if (r.status !== 0 || !r.stdout.length) return 0; // no alpha channel: nothing to measure
  let faint = 0;
  for (const a of r.stdout) if (a > 0 && a <= FAINT_ALPHA) faint++;
  return faint / r.stdout.length;
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
