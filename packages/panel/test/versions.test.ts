import { describe, expect, it } from "vitest";
import { olderVersion } from "../src/versions";

describe("olderVersion", () => {
  it("compares versions part by part, as numbers", () => {
    expect(olderVersion("0.4.1", "0.4.2")).toBe(true);
    expect(olderVersion("0.4.2", "0.4.2")).toBe(false);
    expect(olderVersion("0.4.10", "0.4.9")).toBe(false);
    expect(olderVersion("0.3.9", "0.4.0")).toBe(true);
    expect(olderVersion("0.4", "0.4.1")).toBe(true);
  });
});
