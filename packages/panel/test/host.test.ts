import { describe, expect, it } from "vitest";
import { host, setHost, type Host } from "../src/host";

describe("host", () => {
  it("throws a clear error when no host was installed", () => {
    expect(() => host()).toThrow(/no host/i);
  });
  it("returns the installed host", () => {
    const fake = { kind: "premiere" } as Host;
    setHost(fake);
    expect(host()).toBe(fake);
  });
});
