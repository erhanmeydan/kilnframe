import { describe, expect, it } from "vitest";
import {
  formatFps,
  fpsToNumber,
  framesToSeconds,
  parseFps,
  secondsToFrame,
  renderFps,
} from "../src/index.js";

describe("parseFps", () => {
  it("parses rational and integer rates", () => {
    expect(parseFps("30000/1001")).toEqual({ num: 30000, den: 1001 });
    expect(parseFps("25")).toEqual({ num: 25, den: 1 });
    expect(fpsToNumber(parseFps("30000/1001"))).toBeCloseTo(29.97, 2);
  });

  it("rejects invalid input", () => {
    expect(() => parseFps("29.97")).toThrow(/Invalid fps/);
    expect(() => parseFps("0/1")).toThrow(/positive/);
    expect(() => parseFps("30/0")).toThrow(/positive/);
  });

  it("formats back to the canonical string", () => {
    expect(formatFps(parseFps("24/1"))).toBe("24");
    expect(formatFps(parseFps("30000/1001"))).toBe("30000/1001");
  });
});

describe("frame/time conversion", () => {
  const ntsc = parseFps("30000/1001");

  it("is exact at 29.97", () => {
    expect(framesToSeconds(30000, ntsc)).toBe(1001);
    expect(secondsToFrame(1001, ntsc)).toBe(30000);
  });

  it("matches the previous project's 25 fps handles", () => {
    const pal = parseFps("25");
    expect(framesToSeconds(20, pal)).toBe(0.8);
    expect(secondsToFrame(4.08, pal)).toBe(102);
  });
});

describe("renderFps", () => {
  it("keeps standard rates and moves Premiere's measured VFR rates to the nearest standard", () => {
    expect(formatFps(renderFps(parseFps("30000/1001")))).toBe("30000/1001");
    expect(formatFps(renderFps(parseFps("25")))).toBe("25");
    // hinton.mp4 in Premiere 26.5.2: 23.993 fps
    expect(formatFps(renderFps(parseFps("254016000000/10587056659")))).toBe("24");
    expect(formatFps(renderFps(parseFps("2997/100")))).toBe("30000/1001");
  });
});
