import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  draftToPlan,
  loadRecipes,
  loadStyle,
  parseFps,
  planProblems,
  planRequestText,
  PlanDraftSchema,
  type PlanDraft,
  type PlanJob,
  type Transcript,
} from "../src/index.js";

const recipes = loadRecipes(join(import.meta.dirname, "fixtures", "recipes"));
const style = loadStyle("flat-infografik");
const job: PlanJob = {
  style: "flat-infografik",
  mode: "fullscreen",
  format: "landscape",
  width: 1920,
  height: 1080,
  fps: parseFps("25"),
  handlesFrames: 20,
};
const transcript: Transcript = {
  version: 1,
  language: "tr",
  model: "test",
  duration_s: 5,
  text: "Üç adımda",
  words: [{ text: "Üç", start: 0.5, end: 0.8 }],
};

function draft(scene: Partial<PlanDraft["scenes"][number]>): PlanDraft {
  return PlanDraftSchema.parse({
    topic: "t",
    summary: "s",
    scenes: [
      {
        id: "s1",
        start_s: 0,
        end_s: 5,
        anchor_words: ["Üç"],
        visual: "a title",
        on_screen_text: null,
        camera: "hold",
        technique: "kinetic-type",
        transition_out: "cut",
        assets: [],
        sfx: [],
        ...scene,
      },
    ],
  });
}

describe("recipes in the plan", () => {
  it("keeps a scene without a recipe as before", () => {
    const plan = draftToPlan(draft({}), job, 5);
    expect(plan.scenes[0]).not.toHaveProperty("recipe");
    expect(planProblems(draft({}), style, [], job, recipes)).toEqual([]);
  });
  it("carries the recipe into the plan", () => {
    expect(draftToPlan(draft({ recipe: "demo" }), job, 5).scenes[0]?.recipe).toBe("demo");
  });
  it("lists the available recipes in the request", () => {
    const text = planRequestText(transcript, style, job, recipes);
    expect(text).toContain("Recipes for this style and format");
    expect(text).toContain("demo (kinetic-type; fullscreen)");
    expect(text).toContain(recipes[0]?.description);
  });
  it("lists no recipes when none is given or none has a dress", () => {
    expect(planRequestText(transcript, style, job)).not.toContain("Recipes");
    expect(planRequestText(transcript, loadStyle("beyaz-tahta"), job, recipes)).not.toContain(
      "Recipes",
    );
  });
  it("rejects an unknown recipe", () => {
    expect(planProblems(draft({ recipe: "nope" }), style, [], job, recipes).join(" ")).toContain(
      "nope",
    );
  });
  it("rejects a recipe of another technique", () => {
    const p = planProblems(
      draft({ recipe: "demo", technique: "data-viz" }),
      style,
      [],
      job,
      recipes,
    );
    expect(p.join(" ")).toContain("kinetic-type");
  });
  it("rejects a recipe in a mode it does not support", () => {
    const p = planProblems(
      draft({ recipe: "demo" }),
      style,
      [],
      { ...job, mode: "overlay" },
      recipes,
    );
    expect(p.join(" ")).toContain("overlay");
  });
  it("rejects a recipe on a scene that uses the editor's images", () => {
    const p = planProblems(
      draft({ recipe: "demo", assets: [{ id: "a1", role: "hero", marks: [] }] }),
      style,
      [{ id: "a1", width: 100, height: 100, lines: [] }],
      job,
      recipes,
    );
    expect(p.join(" ")).toContain("images");
  });
});

describe("recipes switch", () => {
  it("leaves recipes off unless the settings or the caller turn them on", async () => {
    const { loadDefaults, pipelineRecipes } = await import("../src/index.js");
    const defaults = loadDefaults();
    expect(defaults.recipes.enabled).toBe(false);
    expect(pipelineRecipes(undefined, defaults)).toEqual([]);
    expect(pipelineRecipes(true, defaults).length).toBeGreaterThan(0);
    expect(pipelineRecipes(false, { ...defaults, recipes: { enabled: true } })).toEqual([]);
    expect(
      pipelineRecipes(undefined, { ...defaults, recipes: { enabled: true } }).length,
    ).toBeGreaterThan(0);
  });
});
