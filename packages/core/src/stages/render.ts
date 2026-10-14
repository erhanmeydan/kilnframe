import { edgeCutScenes } from "../edges.js";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { checkProject, renderProject, snapshotProject, type CheckFinding } from "../hyperframes.js";
import { formatFps, framesToSeconds, parseFps, renderFps } from "../fps.js";
import { compositeOver, nearestFrame, readFrames } from "../frames.js";
import { assembleProject } from "../project/assemble.js";
import { PlanSchema, sceneMode, type Plan } from "../schemas/plan.js";
import type { Transcript } from "../schemas/transcript.js";
import { buildPreview, deliver } from "./deliver.js";
import { renderSfx, type SfxResult } from "./sfx.js";
import { fullness, pickStill, stillCandidates } from "./still-pick.js";

export class ValidationError extends Error {
  constructor(
    message: string,
    readonly findings: CheckFinding[],
  ) {
    super(message);
  }
}

export interface RenderPlanOptions {
  plan: Plan;
  scenes: Record<string, string>;
  outDir: string;
  /** Stop after the stills so the user can approve them before the full render. */
  stillsOnly?: boolean;
  /** The project was already assembled and passed `hyperframes check` with these scenes. */
  prechecked?: boolean;
  /** Original speech of the range; when given, a preview with speech and effects is written. */
  speechPath?: string | undefined;
  onProgress?: (message: string) => void;
}

export interface RenderPlanResult {
  projectDir: string;
  stills: string[];
  output: string | null;
  preview: string | null;
  sfx: SfxResult | null;
  timingsMs: Record<string, number>;
  warnings: CheckFinding[];
  /** Scenes whose review still has a small drawing cut by the frame's edge: a note for the editor. */
  cutScenes: string[];
}

/**
 * One still per scene for the review, taken once the scene has settled. Text and shapes reveal on their
 * words, so a fixed point (80% through, used before 9 Oct 2026) often caught them half written ("HABE").
 * With the transcript the still waits for the scene's last spoken word plus 0.6 s for its reveal; without
 * words it stays at 80%. Never in the last 0.2 s (the exit or the next scene) nor before the middle.
 */
export function stillTimes(plan: Plan, words: { start: number }[] = []): number[] {
  const fps = parseFps(plan.fps);
  return plan.scenes.map((s) => {
    const start = framesToSeconds(s.start_frame, fps);
    const end = framesToSeconds(s.end_frame, fps);
    const spoken = words.filter((w) => w.start >= start && w.start < end);
    const last = spoken.length ? Math.max(...spoken.map((w) => w.start)) : null;
    const wanted = last === null ? start + (end - start) * 0.8 : last + 0.6;
    const late = Math.min(wanted, end - 0.2);
    return Math.max(late, (start + end) / 2);
  });
}

/** The words of the range from the job folder, for the still times; none when there is no transcript. */
function transcriptWords(outDir: string): { start: number }[] {
  try {
    return (JSON.parse(readFileSync(join(outDir, "transcript.json"), "utf8")) as Transcript).words;
  } catch {
    return [];
  }
}

/**
 * The review shows an overlay scene over the footage it will sit on, so the editor sees whether it covers
 * the face before the render. The transparent still is kept in stills/alpha/.
 */
function showOverlaysOverFootage(
  plan: Plan,
  stills: string[],
  outDir: string,
  times: number[],
): void {
  const frames = readFrames(outDir);
  if (!frames.length || stills.length !== plan.scenes.length) return;
  plan.scenes.forEach((scene, i) => {
    const still = stills[i] as string;
    const frame = nearestFrame(frames, times[i] as number);
    if (sceneMode(plan, scene) !== "overlay" || !frame) return;
    const alphaDir = join(dirname(still), "alpha");
    mkdirSync(alphaDir, { recursive: true });
    const alpha = join(alphaDir, basename(still));
    copyFileSync(still, alpha);
    compositeOver(alpha, frame.file, still);
  });
}

/**
 * One still per scene for the review: a few frames per scene in one snapshot run, the fullest kept
 * (still-pick.ts). Returns the stills in scene order and the time each was taken.
 */
async function reviewStills(
  plan: Plan,
  projectDir: string,
  outDir: string,
  stillsDir: string,
): Promise<{ stills: string[]; times: number[]; ms: number }> {
  const fps = parseFps(plan.fps);
  const usual = stillTimes(plan, transcriptWords(outDir));
  const candidates = stillCandidates(
    plan.scenes.map((s) => ({
      startS: framesToSeconds(s.start_frame, fps),
      endS: framesToSeconds(s.end_frame, fps),
    })),
    usual,
  );
  const sampleDir = join(stillsDir, "samples");
  // a scene made again renders all stills anew: nothing of the last review stays
  rmSync(stillsDir, { recursive: true, force: true });
  mkdirSync(stillsDir, { recursive: true });
  const snap = await snapshotProject(projectDir, candidates.flat(), sampleDir);
  // by number: frame-100 comes after frame-99
  const index = (f: string) => Number(/^frame-(\d+)/.exec(f)?.[1] ?? 0);
  const shots = readdirSync(sampleDir)
    .filter((f) => /^frame-\d+.*\.png$/.test(f))
    .sort((a, b) => index(a) - index(b))
    .map((f) => join(sampleDir, f));
  const stills: string[] = [];
  const times: number[] = [];
  let at = 0;
  candidates.forEach((sceneTimes, i) => {
    const files = shots.slice(at, at + sceneTimes.length);
    at += sceneTimes.length;
    const k =
      files.length === sceneTimes.length
        ? pickStill(sceneTimes, files.map(fullness), usual[i] as number)
        : 0;
    const time = sceneTimes[k] as number;
    const from = files[k];
    if (!from) return;
    const still = join(stillsDir, `frame-${String(i).padStart(2, "0")}-at-${time.toFixed(2)}s.png`);
    copyFileSync(from, still);
    stills.push(still);
    times.push(time);
  });
  rmSync(sampleDir, { recursive: true, force: true });
  return { stills, times, ms: snap.ms };
}

/** The frame of the footage nearest the middle of the range, for the preview of an insert with alpha. */
function middleFrame(outDir: string): string | undefined {
  const frames = readFrames(outDir);
  return frames[Math.floor(frames.length / 2)]?.file;
}

/** validate → stills → render → deliver for an already composed plan. */
export async function renderPlan(o: RenderPlanOptions): Promise<RenderPlanResult> {
  const plan = PlanSchema.parse(o.plan);
  // HyperFrames runs inside the project folder, so every path handed to it must be absolute.
  const outDir = resolve(o.outDir);
  const log = o.onProgress ?? (() => {});
  const timingsMs: Record<string, number> = {};
  const projectDir = join(outDir, "project");
  mkdirSync(outDir, { recursive: true });

  let warnings: CheckFinding[] = [];
  if (!o.prechecked) {
    log("Assembling HyperFrames project");
    assembleProject({ plan, scenes: o.scenes, projectDir, assetsDir: join(outDir, "assets") });
    log("Validating (hyperframes check)");
    const check = await checkProject(projectDir);
    timingsMs.validate = check.ms;
    warnings = check.warnings;
    writeFileSync(join(outDir, "check.json"), `${JSON.stringify(check.raw, null, 2)}\n`);
    if (!check.ok) {
      throw new ValidationError(
        `The composition has ${check.errors.length} problem(s).`,
        check.errors,
      );
    }
  }

  log("Rendering stills");
  const stillsDir = join(outDir, "stills");
  const { stills, times, ms } = await reviewStills(plan, projectDir, outDir, stillsDir);
  timingsMs.stills = ms;
  const cutScenes = edgeCutScenes(plan, stills);
  // kept with the stills: a review opened again after a reload shows the same notes
  writeFileSync(join(stillsDir, "edges.json"), `${JSON.stringify(cutScenes)}\n`);
  showOverlaysOverFootage(plan, stills, outDir, times);
  if (o.stillsOnly)
    return {
      projectDir,
      stills,
      output: null,
      preview: null,
      sfx: null,
      timingsMs,
      warnings,
      cutScenes,
    };

  const format = plan.mode === "overlay" ? "mov" : "mp4";
  const master = join(projectDir, "renders", `master.${format}`);
  log("Rendering video");
  // non-standard sequence rates render at the nearest standard rate; delivery converts to the exact rate
  const render = await renderProject(projectDir, {
    fps: formatFps(renderFps(parseFps(plan.fps))),
    output: master,
    format,
  });
  timingsMs.render = render.ms;

  log("Encoding delivery file with handles");
  const started = Date.now();
  const output = join(outDir, `insert.${format}`);
  await deliver({
    input: master,
    output,
    mode: plan.mode,
    fps: plan.fps,
    width: plan.width,
    height: plan.height,
    handlesFrames: plan.handles_frames,
  });
  timingsMs.deliver = Date.now() - started;

  log("Synthesizing sound effects");
  const sfxStarted = Date.now();
  const sfx = renderSfx(plan, outDir);
  timingsMs.sfx = Date.now() - sfxStarted;

  let preview: string | null = null;
  if (o.speechPath) {
    log("Building preview with speech and effects");
    preview = join(outDir, "preview.mp4");
    await buildPreview({
      video: output,
      speech: o.speechPath,
      sfx: sfx.mix,
      output: preview,
      fps: plan.fps,
      handlesFrames: plan.handles_frames,
      backdrop: middleFrame(outDir),
      // the panel leaves the range's picture next to the job when Premiere could export it
      footage: existsSync(join(outDir, "footage.mp4")) ? join(outDir, "footage.mp4") : undefined,
    });
  }
  return { projectDir, stills, output, preview, sfx, timingsMs, warnings, cutScenes };
}
