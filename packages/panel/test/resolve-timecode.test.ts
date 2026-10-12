import { describe, expect, it } from "vitest";
import { framesToTimecode, parseRate, rateString, timecodeToFrames } from "../src/resolve/timecode";

describe("resolve timecode", () => {
  it("reads Resolve's frame rate strings", () => {
    expect(parseRate("25")).toEqual({ fps: 25, nominal: 25, dropFrame: false });
    expect(parseRate("29.97 DF")).toEqual({ fps: 30000 / 1001, nominal: 30, dropFrame: true });
    expect(parseRate("23.976")).toEqual({ fps: 24000 / 1001, nominal: 24, dropFrame: false });
  });
  it("gives the panel's fps strings", () => {
    expect(rateString(parseRate("29.97"))).toBe("30000/1001");
    expect(rateString(parseRate("23.976"))).toBe("24000/1001");
    expect(rateString(parseRate("59.94 DF"))).toBe("60000/1001");
    expect(rateString(parseRate("25"))).toBe("25");
  });
  it("round-trips non-drop timecode from a 01:00:00:00 start", () => {
    const r = parseRate("25");
    expect(framesToTimecode(90050, r)).toBe("01:00:02:00");
    expect(timecodeToFrames("01:00:02:00", r)).toBe(90050);
  });
  it("handles drop frame: minute 1 skips ;00 and ;01", () => {
    const r = parseRate("29.97 DF");
    expect(framesToTimecode(1800, r)).toBe("00:01:00;02");
    expect(timecodeToFrames("00:01:00;02", r)).toBe(1800);
    expect(framesToTimecode(17982, r)).toBe("00:10:00;00");
    for (const f of [0, 1799, 1800, 17981, 17982, 107892, 107893])
      expect(timecodeToFrames(framesToTimecode(f, r), r)).toBe(f);
  });
});
