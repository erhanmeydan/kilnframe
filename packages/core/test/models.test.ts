import { describe, expect, it } from "vitest";
import { loadModelCatalog, usageCost } from "../src/index.js";

describe("model catalog", () => {
  it("prices the default models and estimates a run", () => {
    const opus = loadModelCatalog().models["claude-opus-5-5"];
    expect(opus?.quality).toBe("best");
    const cost = usageCost(
      {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheWriteTokens: 0,
        cacheReadTokens: 1_000_000,
      },
      opus?.price,
    );
    expect(cost).toBeCloseTo(4 + 2 + 0.2, 6);
    expect(usageCost({ inputTokens: 1, outputTokens: 1 }, undefined)).toBeNull();
  });
});
