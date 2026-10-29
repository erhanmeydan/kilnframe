import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRecipeScene, fillProblems, resolveWords } from "../src/recipe-fill.js";
import { loadRecipes } from "../src/recipes.js";
import { staticSceneProblems } from "../src/stages/compose.js";

const demo = loadRecipes(join(import.meta.dirname, "fixtures", "recipes"))[0]!;
const valid = { title: "Kısa başlık", title_at: 0, items: [{ label: "bir", at: 1 }] };
const input = {
  sceneId: "s3",
  width: 1920,
  height: 1080,
  format: "landscape" as const,
  mode: "fullscreen" as const,
  durationS: 4,
  speakerSide: "center" as const,
  safeArea: { top: 54, right: 96, bottom: 54, left: 96 },
  fontFaces: "",
};
const words = [
  { text: "bir", at: 0 },
  { text: "ikinci", at: 0.62 },
];

describe("fillProblems", () => {
  it("accepts valid data", () => {
    expect(fillProblems(demo, valid, 5)).toEqual([]);
  });
  it("names a missing required text", () => {
    const p = fillProblems(demo, { ...valid, title: undefined }, 5);
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("title");
  });
  it("gives the limit of a text that is too long", () => {
    expect(fillProblems(demo, { ...valid, title: "x".repeat(30) }, 5).join(" ")).toContain("20");
  });
  it("rejects a word index outside the scene's words", () => {
    expect(fillProblems(demo, { ...valid, title_at: 7 }, 5).join(" ")).toContain("7");
  });
  it("rejects every word index when the scene has no words", () => {
    expect(fillProblems(demo, valid, 0).length).toBeGreaterThan(0);
  });
  it("names a list with too few items", () => {
    expect(fillProblems(demo, { ...valid, items: [] }, 5).join(" ")).toContain("items");
  });
  it("rejects data that is not an object", () => {
    expect(fillProblems(demo, "hello", 5).length).toBeGreaterThan(0);
  });
});

describe("resolveWords", () => {
  it("turns word indexes into the word and its time, in lists too", () => {
    const r = resolveWords(demo, { ...valid, title_at: 1 }, words) as Record<string, unknown>;
    expect(r.title_at).toEqual({ text: "ikinci", at: 0.62 });
    expect((r.items as { at: unknown }[])[0]?.at).toEqual({ text: "ikinci", at: 0.62 });
  });
});

describe("buildRecipeScene", () => {
  const html = buildRecipeScene(demo, "flat-infografik", resolveWords(demo, valid, words), input);
  it("fills every placeholder", () => {
    expect(html).not.toMatch(/SCENE_ID|"__DATA__"|\/\*DRESS\*\//);
    expect(html).toContain('data-composition-id="s3"');
    expect(html).toContain('data-width="1920"');
    expect(html).toContain("#s3-bg");
  });
  it("inlines the shared kit with the scene id filled in", () => {
    expect(html).toContain('const KIT_OK = "s3";');
    expect(html).not.toContain("/*KIT*/");
  });
  it("passes the static scene checks", () => {
    expect(staticSceneProblems(html, "s3", [], false)).toEqual([]);
  });
  it("keeps a closing script tag in a text inside the data block", () => {
    const evil = buildRecipeScene(
      demo,
      "flat-infografik",
      resolveWords(demo, { ...valid, title: "a</script>b" }, words),
      input,
    );
    expect(evil).toContain("\\u003c/script>");
    expect(evil).not.toContain("a</script>b");
  });
  it("passes format, mode and speaker side to the skeleton", () => {
    expect(html).toContain('"speakerSide":"center"');
    expect(html).toContain('"format":"landscape"');
  });
});

describe("isRecipeScene", () => {
  it("knows a scene built from a recipe by its data block", async () => {
    const { isRecipeScene } = await import("../src/recipe-fill.js");
    const html = buildRecipeScene(demo, "flat-infografik", resolveWords(demo, valid, words), input);
    expect(isRecipeScene(html, "s3")).toBe(true);
    expect(isRecipeScene('<div id="s3-title"></div>', "s3")).toBe(false);
  });
});
