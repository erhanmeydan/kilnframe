import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRecipeScene,
  composeScene,
  draftToPlan,
  loadPrompt,
  loadRecipes,
  loadStyle,
  parseFps,
  resolveWords,
  staticSceneProblems,
  type ComposeContext,
  type PlanDraft,
  type PlanJob,
  type TextProvider,
  type TextRequest,
  type Transcript,
} from "../src/index.js";

const recipes = loadRecipes(join(import.meta.dirname, "fixtures", "recipes"));
const demo = recipes[0]!;
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
  text: "Üç adımda video",
  words: [
    { text: "Üç", start: 0.5, end: 0.8 },
    { text: "adımda", start: 0.8, end: 1.3 },
    { text: "video", start: 2.2, end: 2.6 },
  ],
};

function planWith(recipe: string | null, words = transcript) {
  const draft: PlanDraft = {
    topic: "t",
    summary: "s",
    scenes: [
      {
        id: "s1",
        start_s: 0,
        end_s: 5,
        anchor_words: ["Üç"],
        visual: "a title and two labels",
        on_screen_text: "ÜÇ ADIM",
        camera: "hold",
        technique: "kinetic-type",
        transition_out: "cut",
        recipe,
        assets: [],
        sfx: [],
      },
    ],
  };
  return { plan: draftToPlan(draft, job, words.duration_s), transcript: words };
}

function fakeProvider(replies: string[]): TextProvider & { requests: TextRequest[] } {
  const requests: TextRequest[] = [];
  return {
    name: "fake",
    model: "fake-1",
    capabilities: { vision: false, structuredOutput: false, contextWindow: 200_000 },
    requests,
    async complete(req) {
      requests.push(structuredClone(req));
      const text = replies.shift();
      if (text === undefined) throw new Error("no more scripted replies");
      return { text, model: "fake-1", usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
}

const good = JSON.stringify({ title: "Üç adım", title_at: 0, items: [{ label: "video", at: 2 }] });
const bad = JSON.stringify({ title: "Üç adım", title_at: 9, items: [] });
// a valid free-written scene, for the fallback
const freeHtml =
  "```html\n" +
  buildRecipeScene(
    demo,
    "flat-infografik",
    resolveWords(demo, JSON.parse(good), [
      { text: "Üç", at: 0.5 },
      { text: "adımda", at: 0.8 },
      { text: "video", at: 2.2 },
    ]),
    {
      sceneId: "s1",
      width: 1920,
      height: 1080,
      format: "landscape",
      mode: "fullscreen",
      durationS: 5,
      speakerSide: "center",
      safeArea: { top: 54, right: 96, bottom: 54, left: 96 },
      fontFaces: "",
    },
  ) +
  "\n```";

function ctxFor(replies: string[], recipe: string | null = "demo", words = transcript) {
  const provider = fakeProvider(replies);
  const { plan } = planWith(recipe, words);
  const ctx: ComposeContext = { provider, plan, transcript: words, style, recipes };
  return { ctx, provider, scene: plan.scenes[0]! };
}

const composeSystem = loadPrompt("compose");

describe("recipe scenes in compose", () => {
  it("fills a recipe scene from one short JSON reply", async () => {
    const { ctx, provider, scene } = ctxFor(["```json\n" + good + "\n```"]);
    const r = await composeScene(ctx, scene);
    expect(provider.requests.map((q) => q.purpose)).toEqual(["fill s1"]);
    expect(r.recipe).toBe("demo");
    expect(staticSceneProblems(r.html, "s1", [], false)).toEqual([]);
    expect(r.html).toContain('"text":"video","at":');
  });

  it("numbers the scene's words in the fill request", async () => {
    const { ctx, provider, scene } = ctxFor([good]);
    await composeScene(ctx, scene);
    const text = JSON.stringify(provider.requests[0]?.messages);
    expect(text).toContain("2 2.20 video");
    expect(text).toContain("at most 20 characters");
  });

  it("sends the problems back once", async () => {
    const { ctx, provider, scene } = ctxFor([bad, good]);
    const r = await composeScene(ctx, scene);
    expect(provider.requests.map((q) => q.purpose)).toEqual(["fill s1", "fill s1 retry"]);
    expect(r.recipe).toBe("demo");
  });

  it("writes the scene freely after two bad fills", async () => {
    const { ctx, provider, scene } = ctxFor([bad, bad, freeHtml]);
    const r = await composeScene(ctx, scene);
    expect(provider.requests).toHaveLength(3);
    expect(provider.requests[2]?.system).toContain(composeSystem.slice(0, 200));
    expect(r.recipe).toBeUndefined();
  });

  it("writes the scene freely when the model asks to", async () => {
    const { ctx, provider, scene } = ctxFor(['{"free": true}', freeHtml]);
    const r = await composeScene(ctx, scene);
    expect(provider.requests.map((q) => q.purpose)).toEqual(["fill s1", "compose s1"]);
    expect(r.recipe).toBeUndefined();
  });

  it("skips the fill when the style has no dress", async () => {
    const { ctx, provider, scene } = ctxFor([freeHtml]);
    const r = await composeScene({ ...ctx, style: loadStyle("beyaz-tahta") }, scene);
    expect(provider.requests.map((q) => q.purpose)).toEqual(["compose s1"]);
    expect(r.recipe).toBeUndefined();
  });

  it("skips the fill when asked for a free scene", async () => {
    const { ctx, provider, scene } = ctxFor([freeHtml]);
    await composeScene(ctx, scene, 3, { free: true });
    expect(provider.requests.map((q) => q.purpose)).toEqual(["compose s1"]);
  });

  it("goes free without throwing when the scene has no words", async () => {
    const silent = { ...transcript, words: [], text: "" };
    const { ctx, provider, scene } = ctxFor([good, good, freeHtml], "demo", silent);
    const r = await composeScene(ctx, scene);
    expect(provider.requests).toHaveLength(3);
    expect(r.recipe).toBeUndefined();
  });

  it("passes the editor's note to the fill", async () => {
    const { ctx, provider, scene } = ctxFor([good]);
    await composeScene(ctx, { ...scene, visual: `${scene.visual}\nThe editor asks: bigger title` });
    expect(JSON.stringify(provider.requests[0]?.messages)).toContain("bigger title");
  });
});
