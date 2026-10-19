import { describe, expect, it } from "vitest";
import { keepWhen } from "../src/probe-memo";

describe("keepWhen", () => {
  it("keeps a good answer for the session", async () => {
    let runs = 0;
    const probe = keepWhen(
      async () => (runs++, { mode: "hardware" }),
      (r) => r.mode === "hardware",
    );
    await probe();
    await probe();
    expect(runs).toBe(1);
  });

  it("asks again after a software or unknown answer (a GPU that was busy, a driver that woke up)", async () => {
    let runs = 0;
    const probe = keepWhen(
      async () => (runs++, { mode: "software" }),
      (r) => r.mode === "hardware",
    );
    await probe();
    await probe();
    expect(runs).toBe(2);
  });

  it("shares one probe between callers that ask at the same time", async () => {
    let runs = 0;
    const probe = keepWhen(
      async () => (runs++, { mode: "software" }),
      () => false,
    );
    await Promise.all([probe(), probe()]);
    expect(runs).toBe(1);
  });

  it("asks again after an error", async () => {
    let runs = 0;
    const probe = keepWhen(
      async () => {
        runs++;
        if (runs === 1) throw new Error("no browser");
        return { mode: "hardware" };
      },
      () => true,
    );
    await expect(probe()).rejects.toThrow("no browser");
    await expect(probe()).resolves.toEqual({ mode: "hardware" });
  });
});
