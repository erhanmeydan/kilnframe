import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Defaults } from "../config.js";
import { checkProject, type CheckFinding } from "../hyperframes.js";
import { assembleProject } from "../project/assemble.js";
import { UsageMeter, type TextProvider } from "../providers/types.js";
import { sceneMode, type Plan } from "../schemas/plan.js";
import type { Transcript } from "../schemas/transcript.js";
import { prepareAssets, readAssetText, type AssetInput } from "../assets.js";
import { prepareFrames, type FrameInput } from "../frames.js";
import { loadRecipes } from "../recipes.js";
import { loadStyle } from "../styles.js";
import {
  composeScene,
  repairScene,
  sceneAssetSrcs,
  staticSceneProblems,
  type ComposeContext,
  type ComposedScene,
  keepRejected,
} from "./compose.js";
import { planInsert, type PlanJob } from "./plan.js";
import { extractHtml } from "../prompts.js";
import { renderPlan, stillTimes, type RenderPlanResult } from "./render.js";
import { emptySceneFindings } from "../empty.js";
import { overlayHazeFindings } from "../haze.js";
import { transcribe } from "./transcribe.js";
import { type Price, loadModelCatalog, usageCost } from "../models.js";
import { cutAudio } from "../media/audio.js";
import { correctTranscript } from "../align.js";

export interface PipelineOptions {
  audioPath: string;
  outDir: string;
  job: PlanJob;
  provider: TextProvider;
  defaults: Defaults;
  language?: string | undefined;
  /** Cut this range (seconds) out of the audio file first, e.g. the panel's in/out on a full export. */
  range?: { startS: number; endS: number } | undefined;
  /** The text that was read aloud (story mode): its words replace what Whisper heard, on Whisper's times. */
  script?: string | undefined;
  /** Reuse an existing transcript instead of running Whisper. */
  transcript?: Transcript | undefined;
  stillsOnly?: boolean;
  maxRepairRounds?: number;
  /** The editor's own images. */
  assets?: AssetInput[];
  /** Frames of the footage under the range, for choosing overlays and placing them beside the speaker. */
  frames?: FrameInput[];
  /** Fill scenes from scene recipes where the plan picks one (default true); off for comparisons. */
  recipes?: boolean;
  onProgress?: (message: string) => void;
}

export interface PipelineResult {
  plan: Plan;
  render: RenderPlanResult;
  usage: UsageMeter;
  repairRounds: number;
}

/** Which scene a HyperFrames finding belongs to, from its file or selector. */
export function findingScene(f: CheckFinding, sceneIds: string[]): string | null {
  for (const id of sceneIds) {
    if (f.sourceFile?.includes(`compositions/${id}.html`)) return id;
    if (f.selector && new RegExp(`#${id}-|\\[data-composition-id="${id}"\\]`).test(f.selector))
      return id;
  }
  // Runtime errors are reported against index.html; the scene usually names itself in the message
  // ("s2 build error", "#s2-card"). Only attribute when exactly one scene is named.
  const named = sceneIds.filter((id) => new RegExp(`(^|[^a-z0-9])${id}([^0-9]|$)`).test(f.message));
  return named.length === 1 ? (named[0] as string) : null;
}

/**
 * Finds which scenes throw at runtime by checking each one alone in a small project (all in parallel,
 * about 9 s for 9 scenes). Used when HyperFrames reports errors against index.html without naming a
 * scene. Only runtime errors count: isolated scenes can show seek warnings that the full project does not.
 */
export async function isolateRuntimeErrors(
  plan: Plan,
  scenes: Record<string, string>,
  workDir: string,
  assetsDir?: string,
): Promise<Map<string, CheckFinding[]>> {
  const found = new Map<string, CheckFinding[]>();
  await Promise.all(
    plan.scenes.map(async (s) => {
      const len = s.end_frame - s.start_frame;
      const single: Plan = {
        ...plan,
        duration_frames: len,
        scenes: [{ ...s, start_frame: 0, end_frame: len, sfx: [] }],
      };
      const dir = join(workDir, s.id);
      assembleProject({
        plan: single,
        scenes: { [s.id]: scenes[s.id] as string },
        projectDir: dir,
        assetsDir,
      });
      const check = await checkProject(dir);
      const runtime = check.errors.filter((e) => e.section === "runtime");
      if (runtime.length) found.set(s.id, runtime);
    }),
  );
  return found;
}

function writeJson(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

export interface RepairLoopOptions {
  ctx: ComposeContext;
  plan: Plan;
  /** Composed scenes with their conversations; repaired scenes are replaced in place. */
  composed: Map<string, ComposedScene>;
  outDir: string;
  maxRounds: number;
  log: (message: string) => void;
  /** Called before giving up, e.g. to write usage.json. */
  onGiveUp?: () => void;
}

/**
 * Assembles the project, runs HyperFrames' check and sends the findings back to the scenes they belong to,
 * up to maxRounds times. Returns the number of repair rounds used.
 */
export async function validateAndRepair(a: RepairLoopOptions): Promise<number> {
  const { ctx, plan, composed, outDir, maxRounds, log } = a;
  const projectDir = join(outDir, "project");
  const sceneIds = plan.scenes.map((s) => s.id);
  let round = 0;
  // Static problems in a rejected repair reply, told to the model in the next round.
  const rejected = new Map<string, string[]>();
  for (;;) {
    const scenes = Object.fromEntries([...composed.values()].map((c) => [c.id, c.html]));
    assembleProject({ plan, scenes, projectDir, assetsDir: join(outDir, "assets") });
    log(round === 0 ? "Validating (hyperframes check)" : `Validating after repair round ${round}`);
    const check = await checkProject(projectDir);
    writeJson(join(outDir, "check.json"), check.raw);
    // every round is kept, so a run shows what had to be repaired (the benchmark reads these)
    writeJson(join(outDir, "checks", `round-${round}.json`), check.raw);
    let errors = check.errors;
    if (check.ok) {
      // the code passed; an overlay may still lay a faint layer over the speaker, which only the pixels show
      const times = stillTimes(plan, ctx.transcript.words);
      errors = await overlayHazeFindings(plan, projectDir, times, join(outDir, "checks", "haze"));
      if (errors.length) writeJson(join(outDir, "checks", `haze-${round}.json`), errors);
      // and a scene may run cleanly yet show nothing: a camera looking past its objects
      const empty = await emptySceneFindings(
        plan,
        projectDir,
        times,
        join(outDir, "checks", "empty"),
      );
      if (empty.length) writeJson(join(outDir, "checks", `empty-${round}.json`), empty);
      errors = [...errors, ...empty];
    }
    if (!errors.length) break;
    if (round >= maxRounds) {
      const list = errors.map((e) => `${e.code ?? "check"}: ${e.message}`).join("\n- ");
      a.onGiveUp?.();
      throw new Error(
        `The composition still fails validation after ${maxRounds} repair rounds:\n- ${list}`,
      );
    }
    round++;
    const byScene = new Map<string, CheckFinding[]>();
    const unattributed: CheckFinding[] = [];
    for (const f of errors) {
      const id = findingScene(f, sceneIds);
      if (id) byScene.set(id, [...(byScene.get(id) ?? []), f]);
      else unattributed.push(f);
    }
    // Errors without an owner most likely come from the scenes already failing; only when no scene is
    // named at all does every scene get them (repairing all scenes is slow and costly).
    if (unattributed.length && byScene.size === 0) {
      log("Locating the failing scenes");
      const scenes = Object.fromEntries([...composed.values()].map((c) => [c.id, c.html]));
      const isolated = await isolateRuntimeErrors(
        plan,
        scenes,
        join(outDir, "isolate"),
        join(outDir, "assets"),
      );
      for (const [id, findings] of isolated) byScene.set(id, findings);
    }
    if (unattributed.length) {
      for (const target of byScene.size ? [...byScene.keys()] : sceneIds) {
        byScene.set(target, [...(byScene.get(target) ?? []), ...unattributed]);
      }
    }
    log(
      `Repairing ${[...byScene.entries()]
        .map(([id, fs]) => `${id} (${[...new Set(fs.map((f) => f.code ?? "check"))].join(", ")})`)
        .join(", ")}`,
    );
    await Promise.all(
      [...byScene.entries()].map(async ([id, findings]) => {
        const scene = plan.scenes.find((s) => s.id === id);
        const prev = composed.get(id);
        if (!scene || !prev) return;
        const problems = [
          ...findings.map(
            (f) =>
              `${f.code ? `[${f.code}] ` : ""}${f.message}${f.fixHint ? ` Fix: ${f.fixHint}` : ""}`,
          ),
          ...(rejected.get(id) ?? []).map((m) => `Your previous fix was rejected: ${m}`),
        ];
        rejected.delete(id);
        // a recipe scene has no code of the model's to repair: write it freely instead
        if (prev.recipe) {
          log(`Recomposing ${id} without its recipe`);
          try {
            composed.set(id, await composeScene(ctx, scene, 3, { free: true }));
          } catch (err) {
            log(`Recomposing ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          return;
        }
        const reply = await repairScene(
          ctx,
          scene,
          prev.messages,
          problems,
          `repair ${id} round ${round}`,
        );
        try {
          const html = extractHtml(reply);
          const extra = staticSceneProblems(
            html,
            id,
            sceneAssetSrcs(plan, scene),
            sceneMode(plan, scene) === "overlay",
          );
          if (extra.length === 0) composed.set(id, { ...prev, html });
          else {
            rejected.set(id, extra);
            keepRejected(ctx.rejectedDir, `${id}-repair-${round}`, reply, extra);
            log(`Repair of ${id} rejected: ${extra.join(" ")}`);
          }
        } catch (err) {
          // keep the previous version; the next check round reports it again
          const msg = err instanceof Error ? err.message : String(err);
          rejected.set(id, [msg]);
          log(`Repair of ${id} rejected: ${msg}`);
        }
      }),
    );
  }

  return round;
}

/** transcribe → plan → compose → validate (with repair) → stills → render → deliver → sfx. */
export async function runPipeline(o: PipelineOptions): Promise<PipelineResult> {
  const log = o.onProgress ?? (() => {});
  const outDir = resolve(o.outDir);
  mkdirSync(outDir, { recursive: true });
  const usage = new UsageMeter();
  /** Written on success and on failure, so a failed run still shows what it cost. */
  // a model models.json does not know may have its price in the provider's list (OpenRouter); looked up
  // in the background, it is there long before the job ends
  let listed: { model: string; price: Price | undefined } | undefined;
  const lookupModel = o.provider.model;
  void o.provider
    .modelPrice?.()
    .then((price) => (listed = { model: lookupModel, price }))
    .catch(() => {});
  const writeUsage = () => {
    const total = usage.total();
    const model = o.provider.model;
    const price =
      loadModelCatalog().models[model]?.price ??
      (listed?.model === model ? listed.price : undefined);
    writeJson(join(outDir, "usage.json"), {
      model: o.provider.model,
      total,
      billing: o.provider.billing ?? "api",
      costUsd: o.provider.billing === "plan" ? 0 : usageCost(total, price),
      listPriceUsd: total.listPriceUsd || usageCost(total, price),
      calls: usage.calls,
    });
  };
  o.provider.preflight?.();
  const provider = usage.wrap(o.provider);
  const style = loadStyle(o.job.style);

  let audioPath = o.audioPath;
  if (o.range) {
    audioPath = join(outDir, "range.wav");
    log(`Cutting audio ${o.range.startS.toFixed(2)}-${o.range.endS.toFixed(2)} s`);
    await cutAudio(o.audioPath, audioPath, o.range.startS, o.range.endS);
  }
  const heard =
    o.transcript ??
    (await transcribe({
      audioPath,
      defaults: o.defaults,
      language: o.language,
      onProgress: log,
    }));
  const transcript = o.script && !o.transcript ? correctTranscript(heard, o.script, log) : heard;
  writeJson(join(outDir, "transcript.json"), transcript);
  // the review step (stages/review.ts) renders later from this folder and needs the speech for the preview
  writeJson(join(outDir, "run.json"), { speechPath: resolve(audioPath), style: o.job.style });

  const assets = prepareAssets(o.assets ?? [], outDir);
  if (assets.length) {
    log(`Images: ${assets.length} added by the editor`);
    await readAssetText(assets, outDir, o.defaults.ocr, log);
    const read = assets.filter((a) => a.lines?.length);
    if (read.length)
      log(`Text read: ${read.map((a) => `${a.id} ${a.lines?.length} line(s)`).join(", ")}`);
  }
  const frames = prepareFrames(o.frames ?? [], outDir);
  if (frames.length) log(`Frames of the footage: ${frames.length}`);
  const recipes = o.recipes === false ? [] : loadRecipes();
  const plan = await planInsert({
    provider,
    transcript,
    style,
    job: { ...o.job, assets, frames },
    onProgress: log,
    recipes,
  });
  writeJson(join(outDir, "plan.json"), plan);
  log(
    `Plan: ${plan.scenes.length} scene(s): ${plan.scenes.map((s) => `${s.id} ${s.technique} ${sceneMode(plan, s)}`).join(", ")}${plan.speaker ? `, speaker ${plan.speaker.side}` : ""}`,
  );

  const ctx: ComposeContext = {
    provider,
    plan,
    transcript,
    style,
    assetPreviews: Object.fromEntries(assets.map((a) => [a.id, a.preview])),
    frames,
    rejectedDir: join(outDir, "rejected"),
    recipes,
  };
  log(`Composing ${plan.scenes.length} scene(s)`);
  const composed = new Map<string, ComposedScene>();
  // one line per finished scene: composing takes minutes and the panel shows how far it is
  let written = 0;
  for (const result of await Promise.all(
    plan.scenes.map((s) =>
      composeScene(ctx, s).then((r) => {
        log(
          `Composed ${r.id}${r.recipe ? ` from recipe ${r.recipe}` : ""} (${++written}/${plan.scenes.length})`,
        );
        return r;
      }),
    ),
  ))
    composed.set(result.id, result);

  const round = await validateAndRepair({
    ctx,
    plan,
    composed,
    outDir,
    maxRounds: o.maxRepairRounds ?? 3,
    log,
    onGiveUp: writeUsage,
  });

  const render = await renderPlan({
    plan,
    scenes: Object.fromEntries([...composed.values()].map((c) => [c.id, c.html])),
    outDir: outDir,
    stillsOnly: o.stillsOnly ?? false,
    prechecked: true,
    speechPath: existsSync(audioPath) ? audioPath : undefined,
    onProgress: log,
  });
  writeUsage();
  return { plan, render, usage, repairRounds: round };
}
