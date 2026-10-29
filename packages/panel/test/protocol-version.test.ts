import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, protocolMismatch } from "../src/companion";
import { PROTOCOL_VERSION as COMPANION_VERSION } from "../../companion/src/protocol";

describe("protocol version", () => {
  it("is the same number in the panel and the companion", () => {
    expect(PROTOCOL_VERSION).toBe(COMPANION_VERSION);
  });

  it("an older companion (1) means the app is out of date", () => {
    expect(protocolMismatch(1)).toBe("app");
  });

  it("a newer companion means the panel is out of date", () => {
    expect(protocolMismatch(PROTOCOL_VERSION + 1)).toBe("panel");
  });

  it("the same version shows no notice", () => {
    expect(protocolMismatch(PROTOCOL_VERSION)).toBeNull();
  });
});
