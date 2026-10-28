import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  OutputFormatSchema,
  OutputModeSchema,
  TechniqueSchema,
  type OutputFormat,
  type OutputMode,
  type Technique,
} from "./schemas/plan.js";

/**
 * A scene recipe: a tested, style-neutral scene skeleton that reads its content from a JSON data block,
 * dressed per style. The model fills the data instead of writing the scene. recipes/<name>/ holds
 * recipe.json, skeleton.html and dress/<style>.css.
 */
export type RecipeField =
  | { type: "text"; max: number; optional?: boolean | undefined }
  | { type: "number"; optional?: boolean | undefined }
  /** An index into the scene's numbered word list; the code turns it into the word and its time. */
  | { type: "word"; optional?: boolean | undefined }
  | { type: "list"; min: number; max: number; of: Record<string, RecipeField> };

const RecipeFieldSchema: z.ZodType<RecipeField> = z.lazy(() =>
  z.union([
    z.object({
      type: z.literal("text"),
      max: z.number().int().positive(),
      optional: z.boolean().optional(),
    }),
    z.object({ type: z.literal("number"), optional: z.boolean().optional() }),
    z.object({ type: z.literal("word"), optional: z.boolean().optional() }),
    z.object({
      type: z.literal("list"),
      min: z.number().int().nonnegative(),
      max: z.number().int().positive(),
      of: z.record(z.string(), RecipeFieldSchema),
    }),
  ]),
);

const RecipeFileSchema = z.object({
  technique: TechniqueSchema,
  /** One English line for the plan prompt: what the recipe shows. */
  description: z.string().min(1),
  formats: z.array(OutputFormatSchema),
  modes: z.array(OutputModeSchema),
  fields: z.record(z.string(), RecipeFieldSchema),
});

export interface RecipeInfo {
  name: string;
  technique: Technique;
  description: string;
  formats: OutputFormat[];
  modes: OutputMode[];
  fields: Record<string, RecipeField>;
  skeleton: string;
  /** recipes/kit.js, shared helpers every skeleton inlines at its KIT placeholder. */
  kit: string;
  /** Style name -> dress CSS. A style without a dress is not offered the recipe. */
  dresses: Record<string, string>;
}

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

export function recipesDir(): string {
  return process.env.KILNFRAME_RECIPES_DIR ?? join(repoRoot, "recipes");
}

export function loadRecipes(dir = recipesDir()): RecipeInfo[] {
  if (!existsSync(dir)) return [];
  const kitPath = join(dir, "kit.js");
  const kit = existsSync(kitPath) ? readFileSync(kitPath, "utf8") : "";
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "recipe.json")))
    .map((d) => d.name)
    .sort()
    .map((name) => {
      const root = join(dir, name);
      const file = join(root, "recipe.json");
      const parsed = RecipeFileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
      if (!parsed.success)
        throw new Error(
          `${file} is not a valid recipe: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        );
      const dressDir = join(root, "dress");
      const dresses = existsSync(dressDir)
        ? Object.fromEntries(
            readdirSync(dressDir)
              .filter((f) => f.endsWith(".css"))
              .map((f) => [f.replace(/\.css$/, ""), readFileSync(join(dressDir, f), "utf8")]),
          )
        : {};
      return {
        name,
        ...parsed.data,
        skeleton: readFileSync(join(root, "skeleton.html"), "utf8"),
        kit,
        dresses,
      };
    });
}

/** The recipes a scene in this style, format and mode can use. */
export function availableRecipes(
  all: RecipeInfo[],
  style: string,
  format: OutputFormat,
  mode: OutputMode,
): RecipeInfo[] {
  return all.filter(
    (r) => r.dresses[style] !== undefined && r.formats.includes(format) && r.modes.includes(mode),
  );
}
