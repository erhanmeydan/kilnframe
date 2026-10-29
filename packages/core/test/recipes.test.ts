import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { availableRecipes, loadRecipes } from "../src/recipes.js";

const fixtureDir = join(import.meta.dirname, "fixtures", "recipes");

describe("loadRecipes", () => {
  it("reads a recipe folder with its skeleton and dresses", () => {
    const all = loadRecipes(fixtureDir);
    expect(all.map((r) => r.name)).toEqual(["demo"]);
    const demo = all[0];
    expect(demo?.technique).toBe("kinetic-type");
    expect(demo?.skeleton).toContain('"__DATA__"');
    expect(demo?.dresses["flat-infografik"]).toContain("#edeae3");
  });

  it("names the file when recipe.json is invalid", () => {
    const dir = mkdtempSync(join(tmpdir(), "recipes-"));
    cpSync(join(fixtureDir, "demo"), join(dir, "bad"), { recursive: true });
    writeFileSync(
      join(dir, "bad", "recipe.json"),
      JSON.stringify({ technique: "nope", description: "x", formats: [], modes: [], fields: {} }),
    );
    expect(() => loadRecipes(dir)).toThrow(/recipe\.json/);
  });
});

describe("availableRecipes", () => {
  const all = loadRecipes(fixtureDir);
  it("offers a recipe only where its style has a dress", () => {
    expect(availableRecipes(all, "beyaz-tahta", "landscape", "fullscreen")).toEqual([]);
    expect(availableRecipes(all, "flat-infografik", "landscape", "fullscreen")).toHaveLength(1);
  });
  it("offers a recipe only in the formats and modes it lists", () => {
    expect(availableRecipes(all, "flat-infografik", "portrait", "fullscreen")).toEqual([]);
    expect(availableRecipes(all, "flat-infografik", "landscape", "overlay")).toEqual([]);
  });
});

describe("recipesForPlan", () => {
  it("loads nothing for a plan without recipe scenes, and never throws for a broken folder", async () => {
    const { recipesForPlan } = await import("../src/recipes.js");
    const broken = mkdtempSync(join(tmpdir(), "recipes-"));
    cpSync(join(fixtureDir, "demo"), join(broken, "bad"), { recursive: true });
    writeFileSync(join(broken, "bad", "recipe.json"), "{ not json");
    expect(recipesForPlan([{ recipe: null }, {}], broken)).toEqual([]);
    expect(recipesForPlan([{ recipe: "bad" }], broken)).toEqual([]);
    expect(recipesForPlan([{ recipe: "demo" }], fixtureDir)).toHaveLength(1);
  });
});
