// usage.json in a job folder: the tokens a job used and what they cost. The pipeline writes it (run.ts);
// a scene made again later adds its calls here, and the panel shows the summary once the insert is placed.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Price, usageCost } from "./models.js";
import type { Usage } from "./providers/types.js";

type Call = { purpose: string; model: string; usage: Usage };

interface UsageFile {
  model: string;
  total: Usage;
  billing: "plan" | "api";
  /** What the user pays: 0 on a plan, null when the price is unknown. */
  costUsd: number | null;
  /** The same tokens at API list prices, null when unknown. */
  listPriceUsd: number | null;
  calls: Call[];
}

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  listPriceUsd: number | null;
  billing: "plan" | "api";
}

const fileOf = (outDir: string) => join(outDir, "usage.json");

function sum(calls: Call[]): Usage {
  return calls.reduce<Usage>(
    (t, c) => ({
      inputTokens: t.inputTokens + c.usage.inputTokens,
      outputTokens: t.outputTokens + c.usage.outputTokens,
      cacheWriteTokens: (t.cacheWriteTokens ?? 0) + (c.usage.cacheWriteTokens ?? 0),
      cacheReadTokens: (t.cacheReadTokens ?? 0) + (c.usage.cacheReadTokens ?? 0),
      listPriceUsd: (t.listPriceUsd ?? 0) + (c.usage.listPriceUsd ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, listPriceUsd: 0 },
  );
}

const add = (a: number | null, b: number | null) => (a === null || b === null ? null : a + b);

/** Adds calls (a scene made again) to the job's usage.json, or starts one. */
export function addUsage(
  outDir: string,
  o: { model: string; billing: "plan" | "api"; calls: Call[]; price?: Price | undefined },
): void {
  const before: UsageFile | null = existsSync(fileOf(outDir))
    ? (JSON.parse(readFileSync(fileOf(outDir), "utf8")) as UsageFile)
    : null;
  const added = sum(o.calls);
  // Claude Code reports a list price per call; otherwise the model's price gives it
  const list = added.listPriceUsd || usageCost(added, o.price);
  const next: UsageFile = {
    model: o.model,
    total: sum([...(before?.calls ?? []), ...o.calls]),
    billing: o.billing,
    costUsd: o.billing === "plan" ? (before?.costUsd ?? 0) : add(before ? before.costUsd : 0, list),
    listPriceUsd: add(before ? before.listPriceUsd : 0, list),
    calls: [...(before?.calls ?? []), ...o.calls],
  };
  writeFileSync(fileOf(outDir), `${JSON.stringify(next, null, 2)}\n`);
}

/** The job's tokens and cost for the panel; null when the job folder has no usage.json. */
export function readUsageSummary(outDir: string): UsageSummary | null {
  if (!existsSync(fileOf(outDir))) return null;
  try {
    const u = JSON.parse(readFileSync(fileOf(outDir), "utf8")) as UsageFile;
    return {
      inputTokens:
        (u.total.inputTokens ?? 0) +
        (u.total.cacheReadTokens ?? 0) +
        (u.total.cacheWriteTokens ?? 0),
      outputTokens: u.total.outputTokens ?? 0,
      costUsd: u.costUsd ?? null,
      listPriceUsd: u.listPriceUsd ?? null,
      billing: u.billing === "plan" ? "plan" : "api",
    };
  } catch {
    return null;
  }
}
