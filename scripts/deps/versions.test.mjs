import { describe, expect, it } from "vitest";
import { bump, compare, isPrerelease } from "./versions.mjs";

describe("versions", () => {
  it("orders semver and four-part versions", () => {
    expect(compare("0.8.133", "0.8.140")).toBeLessThan(0);
    expect(compare("152.0.7977.30", "150.0.7871.24")).toBeGreaterThan(0);
    expect(compare("3.15.0", "3.15.0")).toBe(0);
  });
  it("orders FFmpeg build ids and BtbN tags by their embedded numbers", () => {
    expect(compare("1789931890_9.0.2", "1791000000_9.0.3")).toBeLessThan(0);
    expect(compare("autobuild-2026-09-30-13-08", "autobuild-2026-10-31-13-05")).toBeLessThan(0);
  });
  it("classifies the size of a step", () => {
    expect(bump("0.8.133", "0.8.140")).toBe("patch");
    expect(bump("44.7.0", "44.8.0")).toBe("minor");
    expect(bump("44.7.0", "45.0.0")).toBe("major");
    expect(bump("abc123", "def456")).toBe("other");
    expect(bump("1.0.0", "1.0.0")).toBe("none");
  });
  it("spots pre-releases", () => {
    for (const v of ["1.0.0-beta.1", "2.0.0-rc.0", "0.9.0-canary.3", "5.0.0-next.1", "3.0.0-alpha"])
      expect(isPrerelease(v)).toBe(true);
    expect(isPrerelease("0.8.140")).toBe(false);
    expect(isPrerelease("autobuild-2026-10-31-13-05")).toBe(false);
  });
});
