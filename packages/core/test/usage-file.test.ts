import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addUsage, readUsageSummary } from "../src/index.js";

const price = { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 };
const call = (purpose: string, input: number, output: number) => ({
  purpose,
  model: "m",
  usage: { inputTokens: input, outputTokens: output, cacheWriteTokens: 0, cacheReadTokens: 0 },
});

describe("job usage file", () => {
  it("has no summary before a job wrote one", () => {
    expect(readUsageSummary(mkdtempSync(join(tmpdir(), "kf-usage-")))).toBeNull();
  });

  it("adds a recomposed scene's calls to the job's usage and cost", () => {
    const dir = mkdtempSync(join(tmpdir(), "kf-usage-"));
    addUsage(dir, { model: "m", billing: "api", calls: [call("plan", 1_000_000, 0)], price });
    addUsage(dir, { model: "m", billing: "api", calls: [call("recompose s1", 0, 100_000)], price });
    const file = JSON.parse(readFileSync(join(dir, "usage.json"), "utf8"));
    expect(file.calls.map((c: { purpose: string }) => c.purpose)).toEqual(["plan", "recompose s1"]);
    expect(readUsageSummary(dir)).toEqual({
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      costUsd: 3,
      listPriceUsd: 3,
      billing: "api",
    });
  });

  it("costs nothing on a plan, keeps the list price, and says null when a price is unknown", () => {
    const plan = mkdtempSync(join(tmpdir(), "kf-usage-"));
    addUsage(plan, { model: "m", billing: "plan", calls: [call("plan", 1_000_000, 0)], price });
    expect(readUsageSummary(plan)).toMatchObject({ costUsd: 0, listPriceUsd: 2, billing: "plan" });

    const unknown = mkdtempSync(join(tmpdir(), "kf-usage-"));
    addUsage(unknown, { model: "x", billing: "api", calls: [call("plan", 10, 10)] });
    expect(readUsageSummary(unknown)).toMatchObject({ costUsd: null, listPriceUsd: null });
  });

  it("reads the usage.json a pipeline run wrote", () => {
    const dir = mkdtempSync(join(tmpdir(), "kf-usage-"));
    writeFileSync(
      join(dir, "usage.json"),
      JSON.stringify({
        model: "m",
        total: { inputTokens: 66007, outputTokens: 165632, cacheReadTokens: 16896 },
        billing: "api",
        costUsd: 0.0932,
        listPriceUsd: 0.0932,
        calls: [],
      }),
    );
    // cached input counts as input here: the summary is what the model read
    expect(readUsageSummary(dir)).toEqual({
      inputTokens: 66007 + 16896,
      outputTokens: 165632,
      costUsd: 0.0932,
      listPriceUsd: 0.0932,
      billing: "api",
    });
  });
});
