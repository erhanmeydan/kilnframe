import { describe, expect, it } from "vitest";
import { audioRangeParams } from "../src/audio-range";

describe("audioRangeParams", () => {
  it("leaves the range as it is for a whole-sequence export (Premiere)", () => {
    expect(audioRangeParams({ startS: 1.4, endS: 10.84 }, 0)).toEqual({
      rangeStartS: 1.4,
      rangeEndS: 10.84,
    });
  });
  it("makes the range relative to an export that starts at the range (Resolve)", () => {
    const r = audioRangeParams({ startS: 2.4, endS: 9.4 }, 2.4);
    expect(r.rangeStartS).toBe(0);
    expect(r.rangeEndS).toBeCloseTo(7);
  });
});
