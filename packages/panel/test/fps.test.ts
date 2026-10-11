import { describe, expect, it } from "vitest";
import { formatRational, rationalFps } from "../src/fps.js";

const TICKS = 254016000000;

describe("rationalFps", () => {
  it("recovers exact broadcast rates from Premiere ticks", () => {
    expect(formatRational(rationalFps(TICKS, 8475667200))).toBe("30000/1001");
    expect(formatRational(rationalFps(TICKS, 10594584000))).toBe("24000/1001");
    expect(formatRational(rationalFps(TICKS, 10160640000))).toBe("25");
    expect(formatRational(rationalFps(TICKS, 4237833600))).toBe("60000/1001");
  });

  it("rejects a zero frame duration", () => {
    expect(() => rationalFps(TICKS, 0)).toThrow(/Invalid/);
  });
});
