import { z } from "zod";
import type { RecipeField, RecipeInfo } from "./recipes.js";
import type { OutputFormat, OutputMode, SpeakerSide } from "./schemas/plan.js";

type Fields = Record<string, RecipeField>;

function fieldSchema(f: RecipeField): z.ZodType {
  const base: z.ZodType =
    f.type === "text"
      ? z.string().min(1).max(f.max, `at most ${f.max} characters`)
      : f.type === "number"
        ? z.number()
        : f.type === "word"
          ? z.number().int().nonnegative()
          : z.array(objectSchema(f.of)).min(f.min).max(f.max);
  return f.type !== "list" && f.optional ? base.nullable().optional() : base;
}

function objectSchema(fields: Fields): z.ZodType {
  return z.object(Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, fieldSchema(f)])));
}

/** Word indexes in the data, with their paths ("items.2.at"). */
function wordIndexes(fields: Fields, data: unknown, path: string[] = []): [string, number][] {
  if (!data || typeof data !== "object") return [];
  const o = data as Record<string, unknown>;
  return Object.entries(fields).flatMap(([k, f]): [string, number][] => {
    const v = o[k];
    if (f.type === "word" && typeof v === "number") return [[[...path, k].join("."), v]];
    if (f.type === "list" && Array.isArray(v))
      return v.flatMap((item, i) => wordIndexes(f.of, item, [...path, k, String(i)]));
    return [];
  });
}

/** Problems in the model's data, one readable line each; [] when valid. */
export function fillProblems(recipe: RecipeInfo, data: unknown, wordCount: number): string[] {
  const parsed = objectSchema(recipe.fields).safeParse(data);
  if (!parsed.success)
    return parsed.error.issues.map((i) => `${i.path.join(".") || "(data)"}: ${i.message}`);
  return wordIndexes(recipe.fields, data)
    .filter(([, n]) => n >= wordCount)
    .map(([path, n]) =>
      wordCount === 0
        ? `${path}: ${n} points at a word, but this scene has no words`
        : `${path}: word ${n} is not in the list (0 to ${wordCount - 1})`,
    );
}

function resolveObject(
  fields: Fields,
  data: Record<string, unknown>,
  words: { text: string; at: number }[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data };
  for (const [k, f] of Object.entries(fields)) {
    const v = data[k];
    if (f.type === "word" && typeof v === "number") out[k] = words[v] ?? null;
    else if (f.type === "list" && Array.isArray(v))
      out[k] = v.map((item) => resolveObject(f.of, item as Record<string, unknown>, words));
  }
  return out;
}

/** Replaces every word field (an index) with { text, at } from the scene's words (seconds from scene start). */
export function resolveWords(
  recipe: RecipeInfo,
  data: Record<string, unknown>,
  words: { text: string; at: number }[],
): Record<string, unknown> {
  return resolveObject(recipe.fields, data, words);
}

export interface RecipeSceneInput {
  sceneId: string;
  width: number;
  height: number;
  format: OutputFormat;
  mode: OutputMode;
  durationS: number;
  speakerSide: SpeakerSide;
  safeArea: { top: number; right: number; bottom: number; left: number };
  /** @font-face rules for the style's fonts. */
  fontFaces: string;
}

/** The scene HTML: the skeleton with the style's dress and the data block filled in. */
export function buildRecipeScene(
  recipe: RecipeInfo,
  style: string,
  data: Record<string, unknown>,
  input: RecipeSceneInput,
): string {
  const dress = recipe.dresses[style];
  if (dress === undefined) throw new Error(`Recipe ${recipe.name} has no dress for ${style}.`);
  const { sceneId, width, height, fontFaces, ...context } = input;
  // the data goes in last, so nothing the model wrote is taken for a placeholder
  const json = JSON.stringify({ ...data, ...context }).replace(/</g, "\\u003c");
  return recipe.skeleton
    .replace("/*DRESS*/", () => `${fontFaces}\n${dress}`)
    .replace("/*KIT*/", () => recipe.kit)
    .replace(/SCENE_ID/g, sceneId)
    .replace(/\bWIDTH\b/g, String(width))
    .replace(/\bHEIGHT\b/g, String(height))
    .replace('"__DATA__"', () => json);
}

/** Whether a scene's HTML was built from a recipe: the skeletons carry their data in <scene>-data. */
export function isRecipeScene(html: string, sceneId: string): boolean {
  return html.includes(`type="application/json" id="${sceneId}-data"`);
}
