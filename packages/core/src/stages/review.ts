import { loadRecipes } from "../recipes.js";
import { isRecipeScene } from "../recipe-fill.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assetPreview } from "../assets.js";
import { readFrames } from "../frames.js";
import type { Defaults } from "../config.js";
import { UsageMeter, type TextProvider } from "../providers/types.js";
import { PlanSchema, type Plan } from "../schemas/plan.js";
import { TranscriptSchema } from "../schemas/transcript.js";
import { loadStyle } from "../styles.js";
import {
  composeRequest,
  composeScene,
  type ComposeContext,
  type ComposedScene,
} from "./compose.js";
import { renderPlan, type RenderPlanResult } from "./render.js";
import { validateAndRepair } from "./run.js";

/**
 * The still review step: a run with stillsOnly stops after the stills; the editor then
 * approves (render the composed project as it is, no model calls) or asks for one scene again with a note.
 * Everything is read back from the job folder that runPipeline wrote.
 */

interface JobFolder {
  outDir: string;
  plan: Plan;
  scenes: Record<string, string>;
  speechPath: string | undefined;
}

function readJobFolder(outDirIn: string): JobFolder {
  const outDir = resolve(outDirIn);
  const plan = PlanSchema.parse(JSON.parse(readFileSync(join(outDir, "plan.json"), "utf8")));
  const scenes = Object.fromEntries(
    plan.scenes.map((s) => {
      const file = join(outDir, "project", "compositions", `${s.id}.html`);
      if (!existsSync(file)) throw new Error(`Scene ${s.id} is missing in ${outDir}.`);
      return [s.id, readFileSync(file, "utf8")];
    }),
  );
  const runFile = join(outDir, "run.json");
  const speech = existsSync(runFile)
    ? (JSON.parse(readFileSync(runFile, "utf8")) as { speechPath?: string }).speechPath
    : undefined;
  return { outDir, plan, scenes, speechPath: speech && existsSync(speech) ? speech : undefined };
}

/** Renders the approved project: video with handles, sound effects and preview. No model calls. */
export async function renderApproved(o: {
  outDir: string;
  onProgress?: (message: string) => void;
}): Promise<{ plan: Plan; render: RenderPlanResult }> {
  const job = readJobFolder(o.outDir);
  const render = await renderPlan({
    plan: job.plan,
    scenes: job.scenes,
    outDir: job.outDir,
    stillsOnly: false,
    prechecked: true,
    speechPath: job.speechPath,
    ...(o.onProgress ? { onProgress: o.onProgress } : {}),
  });
  return { plan: job.plan, render };
}

export interface RecomposeOptions {
  outDir: string;
  sceneId: string;
  /** The editor's note for this scene ("make the arrows thicker"). */
  note: string;
  provider: TextProvider;
  defaults: Defaults;
  maxRepairRounds?: number;
  onProgress?: (message: string) => void;
}

/**
 * Writes one scene again with the editor's note, checks the whole project (repairing as usual) and renders
 * fresh stills. The other scenes keep their code.
 */
export async function recomposeScene(
  o: RecomposeOptions,
): Promise<{ plan: Plan; render: RenderPlanResult; usage: UsageMeter; repairRounds: number }> {
  const log = o.onProgress ?? (() => {});
  const job = readJobFolder(o.outDir);
  const scene = job.plan.scenes.find((s) => s.id === o.sceneId);
  if (!scene) throw new Error(`There is no scene ${o.sceneId} in this job.`);
  const transcript = TranscriptSchema.parse(
    JSON.parse(readFileSync(join(job.outDir, "transcript.json"), "utf8")),
  );
  const usage = new UsageMeter();
  const ctx: ComposeContext = {
    provider: usage.wrap(o.provider),
    plan: job.plan,
    transcript,
    style: loadStyle(job.plan.style),
    assetPreviews: Object.fromEntries(
      job.plan.assets.flatMap((info) => {
        const preview = assetPreview(job.outDir, info);
        return preview ? [[info.id, preview]] : [];
      }),
    ),
    frames: readFrames(job.outDir),
    recipes: loadRecipes(),
  };
  // the other scenes join with a short conversation (request, their code) so repairs keep their context
  const composed = new Map<string, ComposedScene>();
  for (const s of job.plan.scenes) {
    if (s.id === o.sceneId) continue;
    const html = job.scenes[s.id] as string;
    composed.set(s.id, {
      id: s.id,
      html,
      messages: [
        { role: "user", content: composeRequest(ctx, s) },
        { role: "assistant", content: [{ type: "text", text: "```html\n" + html + "\n```" }] },
      ],
      // only a scene really built from its recipe: one that fell back was written, and is repaired as such
      ...(s.recipe && isRecipeScene(html, s.id) ? { recipe: s.recipe } : {}),
    });
  }
  log(`Composing ${o.sceneId} again`);
  const note = o.note.trim();
  const redo = await composeScene(ctx, {
    ...scene,
    visual: note
      ? `${scene.visual}\nThe editor saw a still of the previous version and asks: ${note}`
      : scene.visual,
  });
  composed.set(o.sceneId, redo);
  const repairRounds = await validateAndRepair({
    ctx,
    plan: job.plan,
    composed,
    outDir: job.outDir,
    maxRounds: o.maxRepairRounds ?? 3,
    log,
  });
  const render = await renderPlan({
    plan: job.plan,
    scenes: Object.fromEntries([...composed.values()].map((c) => [c.id, c.html])),
    outDir: job.outDir,
    stillsOnly: true,
    prechecked: true,
    speechPath: job.speechPath,
    onProgress: log,
  });
  writeFileSync(
    join(job.outDir, `usage-${o.sceneId}-${Date.now()}.json`),
    `${JSON.stringify({ total: usage.total(), calls: usage.calls }, null, 2)}\n`,
  );
  return { plan: job.plan, render, usage, repairRounds };
}
