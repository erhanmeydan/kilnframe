import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Usage } from "./providers/types.js";

const PriceSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheWrite: z.number(),
  cacheRead: z.number(),
});

const CatalogSchema = z.object({
  version: z.literal(1),
  models: z.record(
    z.string(),
    z.object({
      label: z.string(),
      quality: z.enum(["best", "balanced", "fast"]),
      price: PriceSchema,
      measured: z.string().optional(),
    }),
  ),
});
export type ModelCatalog = z.infer<typeof CatalogSchema>;
export type Price = z.infer<typeof PriceSchema>;

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

export function loadModelCatalog(path = join(packageRoot, "config", "models.json")): ModelCatalog {
  return CatalogSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** Dollar cost of a usage total, or null when the model has no known price. */
export function usageCost(usage: Usage, price: Price | undefined): number | null {
  if (!price) return null;
  return (
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      (usage.cacheWriteTokens ?? 0) * price.cacheWrite +
      (usage.cacheReadTokens ?? 0) * price.cacheRead) /
    1_000_000
  );
}
