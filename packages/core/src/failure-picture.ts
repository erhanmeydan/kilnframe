import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ffmpegPath } from "./config.js";
import { snapshotProject, type CheckFinding } from "./hyperframes.js";

/** Where the picture of a failed check is kept in the job folder; the companion sends it to the panel. */
export const FAILURE_PICTURE = join("checks", "failed.jpg");

/** The longer side of the picture: enough to read in the panel, small enough to send as a data URL. */
const LONG_SIDE = 720;

/** The first finding that names a place on the frame (a layout finding: overlapping text, text off frame). */
export function pictureFinding(
  errors: CheckFinding[],
): (CheckFinding & { time: number; rect: NonNullable<CheckFinding["rect"]> }) | null {
  const f = errors.find((e) => typeof e.time === "number" && e.rect && e.rect.width > 0);
  return f ? (f as CheckFinding & { time: number; rect: NonNullable<CheckFinding["rect"]> }) : null;
}

/**
 * FFmpeg filters that draw a red frame around the finding's place, a little outside it so the text stays
 * readable, then scale the frame down (sizes in the composition's pixels, as the snapshot is).
 */
export function pictureFilter(
  rect: NonNullable<CheckFinding["rect"]>,
  frame: { width: number; height: number },
): string {
  // thick enough to see once the frame is shown a few hundred pixels tall in the panel
  const line = Math.max(6, Math.round(Math.max(frame.width, frame.height) / 110));
  const pad = line * 2;
  const x = Math.max(0, Math.round(rect.left - pad));
  const y = Math.max(0, Math.round(rect.top - pad));
  const w = Math.min(frame.width - x, Math.round(rect.width + pad * 2));
  const h = Math.min(frame.height - y, Math.round(rect.height + pad * 2));
  const scale =
    frame.width >= frame.height
      ? `scale='min(${LONG_SIDE},iw)':-2`
      : `scale=-2:'min(${LONG_SIDE},ih)'`;
  return `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=0xE5484D:t=${line},${scale}`;
}

/**
 * Renders the frame the failing check points at, with the place marked, into the job folder
 * (FAILURE_PICTURE). Returns its path, or null when no finding names a place or the frame could not be made:
 * the picture only helps explain the error, so it never adds one.
 */
export async function failurePicture(
  projectDir: string,
  errors: CheckFinding[],
  outDir: string,
  frame: { width: number; height: number },
): Promise<string | null> {
  const out = join(outDir, FAILURE_PICTURE);
  rmSync(out, { force: true });
  const f = pictureFinding(errors);
  if (!f) return null;
  const shots = join(outDir, "checks", "failed-frame");
  try {
    rmSync(shots, { recursive: true, force: true });
    mkdirSync(shots, { recursive: true });
    await snapshotProject(projectDir, [f.time], shots);
    const shot = readdirSync(shots).find((n) => /^frame-.*\.png$/.test(n));
    if (!shot) return null;
    await new Promise<void>((ok, fail) =>
      execFile(
        ffmpegPath(),
        [
          "-v",
          "error",
          "-y",
          "-i",
          join(shots, shot),
          "-vf",
          pictureFilter(f.rect, frame),
          "-q:v",
          "4",
          out,
        ],
        (err) => (err ? fail(err) : ok()),
      ),
    );
    return out;
  } catch {
    return null;
  } finally {
    rmSync(shots, { recursive: true, force: true });
  }
}
