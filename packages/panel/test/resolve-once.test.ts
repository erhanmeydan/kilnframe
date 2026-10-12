import { describe, expect, it, vi } from "vitest";
import { untilItWorks } from "../src/resolve/once";

describe("the connection to Resolve", () => {
  it("is made once and kept", async () => {
    const make = vi.fn(async () => "bridge");
    const get = untilItWorks(make);
    expect(await get()).toBe("bridge");
    expect(await get()).toBe("bridge");
    expect(make).toHaveBeenCalledTimes(1);
  });

  it("is tried again after a failure instead of failing until the panel restarts", async () => {
    let n = 0;
    const get = untilItWorks(async () => {
      if (++n === 1) throw new Error("Resolve not ready");
      return "bridge";
    });
    await expect(get()).rejects.toThrow("Resolve not ready");
    expect(await get()).toBe("bridge");
  });
});
