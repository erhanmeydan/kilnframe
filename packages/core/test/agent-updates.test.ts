import { describe, expect, it } from "vitest";
import { olderVersion } from "../src/index.js";

describe("agent updates", () => {
  it("compares dotted versions", () => {
    expect(olderVersion("2.1.280", "2.1.293")).toBe(true);
    expect(olderVersion("0.2.93", "1.0.13")).toBe(true);
    expect(olderVersion("1.0.46", "1.0.46")).toBe(false);
    expect(olderVersion("2.10.0", "2.9.9")).toBe(false);
    expect(olderVersion("0.161.0", "0.161.0-alpha.1")).toBe(false);
  });
});
