import { describe, expect, it } from "vitest";
import { olderVersion, versionGap } from "../src/versions";

describe("olderVersion", () => {
  it("compares versions part by part, as numbers", () => {
    expect(olderVersion("0.4.1", "0.4.2")).toBe(true);
    expect(olderVersion("0.4.2", "0.4.2")).toBe(false);
    expect(olderVersion("0.4.10", "0.4.9")).toBe(false);
    expect(olderVersion("0.3.9", "0.4.0")).toBe(true);
    expect(olderVersion("0.4", "0.4.1")).toBe(true);
  });
});

describe("versionGap", () => {
  it("says which side is older, and nothing when they match or the app's version is unknown", () => {
    expect(versionGap("0.4.4", "0.4.5")).toBe("panel");
    // a new panel on an old app: the app drops the fields it does not know
    expect(versionGap("0.4.5", "0.4.4")).toBe("app");
    expect(versionGap("0.4.5", "0.4.5")).toBeNull();
    expect(versionGap("0.4.5", null)).toBeNull();
  });
});
