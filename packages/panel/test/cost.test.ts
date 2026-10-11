import { describe, expect, it } from "vitest";
import { addCosts, formatTokens, formatUsd } from "../src/cost.js";

describe("formatTokens", () => {
  it("rounds to thousands and millions in the panel's language", () => {
    expect(formatTokens(82903, true)).toBe("83 bin");
    expect(formatTokens(82903, false)).toBe("83k");
    expect(formatTokens(1_250_000, true)).toBe("1,3 milyon");
    expect(formatTokens(1_250_000, false)).toBe("1.3M");
    expect(formatTokens(640, true)).toBe("640");
  });
});

describe("formatUsd", () => {
  it("writes cents, and says less than a cent for tiny costs", () => {
    expect(formatUsd(0.0932, true)).toBe("0,09 $");
    expect(formatUsd(0.0932, false)).toBe("$0.09");
    expect(formatUsd(4.1, true)).toBe("4,10 $");
    expect(formatUsd(0.004, true)).toBe("0,01 $'dan az");
    expect(formatUsd(0.004, false)).toBe("less than $0.01");
  });
});

describe("addCosts", () => {
  it("adds the parts of a long range; an unknown cost stays unknown", () => {
    const a = {
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.5,
      listPriceUsd: 0.5,
      billing: "api" as const,
    };
    expect(addCosts(null, a)).toEqual(a);
    expect(addCosts(a, a)).toEqual({
      ...a,
      inputTokens: 20,
      outputTokens: 10,
      costUsd: 1,
      listPriceUsd: 1,
    });
    expect(addCosts(a, { ...a, costUsd: null })?.costUsd).toBeNull();
    expect(addCosts(a, null)).toEqual(a);
  });
});
