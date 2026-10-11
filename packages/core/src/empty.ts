// A scene that shows nothing: its code runs without an error and passes the layout check, yet the frame holds
// only the background (a Three.js camera looking past its objects, a scene that never draws, 11 Oct 2026).
// Measured in pixels at two points of each scene; such a scene goes back to repair instead of reaching review.
import { spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ffmpegPath } from "./config.js";
import { framesToSeconds, parseFps } from "./fps.js";
import { snapshotProject, type CheckFinding } from "./hyperframes.js";
import { sceneMode, type Plan } from "./schemas/plan.js";
import { fullness } from "./stages/still-pick.js";

/**
 * Below this edge density a fullscreen frame shows nothing: blank stages measured 0.00, the sparsest real
 * frames (one small object) 0.88 and up, the median 4.5 (173 review stills of past jobs, 11 Oct 2026). A single
 * flat shape on a plain ground measures about 0.15, so the line sits well below it.
 */
const EMPTY_FULLNESS = 0.1;
/** Below this share of clearly visible pixels an overlay draws nothing (a small lower third covers ~2%). */
const EMPTY_OPAQUE_SHARE = 0.001;

/** Share of a transparent frame's pixels that are clearly visible (alpha above 8%). */
function opaqueShare(png: string): number {
  const r = spawnSync(
    ffmpegPath(),
    [
      "-v",
      "error",
      "-i",
      png,
      "-vf",
      "alphaextract,scale=480:270:flags=area",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "-",
    ],
    { maxBuffer: 1 << 24 },
  );
  if (r.status !== 0 || !r.stdout.length) return 1; // no alpha channel: an opaque frame, never "empty"
  let seen = 0;
  for (const a of r.stdout) if (a > 20) seen++;
  return seen / r.stdout.length;
}

/** True when every frame of a scene shows nothing but its background. */
export function looksEmpty(frames: string[], mode: "fullscreen" | "overlay"): boolean {
  return frames.every((f) =>
    mode === "overlay" ? opaqueShare(f) < EMPTY_OPAQUE_SHARE : fullness(f) < EMPTY_FULLNESS,
  );
}

/**
 * Renders every scene at its still time and just before it ends, in one snapshot run, and reports the scenes
 * that show nothing in both.
 */
export async function emptySceneFindings(
  plan: Plan,
  projectDir: string,
  stillTimes: number[],
  workDir: string,
): Promise<CheckFinding[]> {
  const fps = parseFps(plan.fps);
  const times = plan.scenes.map((s, i) => {
    const end = framesToSeconds(s.end_frame, fps) - 0.2;
    const usual = stillTimes[i] as number;
    return end - usual > 0.3 ? [usual, end] : [usual];
  });
  rmSync(workDir, { recursive: true, force: true });
  await snapshotProject(projectDir, times.flat(), workDir);
  const index = (f: string) => Number(/^frame-(\d+)/.exec(f)?.[1] ?? 0);
  const shots = readdirSync(workDir)
    .filter((f) => /^frame-\d+.*\.png$/.test(f))
    .sort((a, b) => index(a) - index(b))
    .map((f) => join(workDir, f));
  const findings: CheckFinding[] = [];
  let at = 0;
  plan.scenes.forEach((s, i) => {
    const sceneTimes = times[i] as number[];
    const files = shots.slice(at, at + sceneTimes.length);
    at += sceneTimes.length;
    if (files.length !== sceneTimes.length) return;
    const mode = sceneMode(plan, s) === "overlay" ? "overlay" : "fullscreen";
    if (!looksEmpty(files, mode)) return;
    findings.push({
      code: "scene_shows_nothing",
      severity: "error",
      section: "pixels",
      selector: `[data-composition-id="${s.id}"]`,
      time: sceneTimes[0] as number,
      message: `Scene ${s.id} shows nothing but its ${mode === "overlay" ? "transparent frame" : "background"} at ${sceneTimes.map((t) => `${t.toFixed(2)} s`).join(" and ")}: no object, text or drawing is visible.`,
      fixHint:
        "Make the scene's content visible: in Three.js point the camera at the objects and keep them inside its view (near and far planes too) and render on every seek; in HTML/SVG check the elements are not hidden, off-canvas, zero-sized or left at opacity 0.",
    });
  });
  return findings;
}
