import { describe, expect, it } from "vitest";
import { LISTEN_HOST, isLoopbackAddress } from "../src/index.js";

describe("loopback guard", () => {
  it("listens on IPv4 loopback", () => {
    expect(LISTEN_HOST).toBe("127.0.0.1");
  });

  it("accepts only loopback peers", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("0.0.0.0")).toBe(false);
    expect(isLoopbackAddress("192.168.1.10")).toBe(false);
  });
});
