import { describe, expect, it } from "vitest";
import { insertScale, renderFrame } from "../src/frame";

describe("insertScale", () => {
  it("leaves sequences up to 4K at 100% and scales a 4K clip up to larger ones", () => {
    expect(insertScale(1920, 1080)).toBe(1);
    expect(insertScale(3840, 2160)).toBe(1);
    expect(insertScale(2160, 3840)).toBe(1);
    expect(insertScale(7680, 4320)).toBe(2);
    expect(insertScale(4320, 7680)).toBe(2);
    expect(insertScale(6144, 3240)).toBe(1.5);
  });
});

describe("renderFrame", () => {
  it("brings a caption clip's frame down to 4K in the sequence's shape, even sizes", () => {
    expect(renderFrame(1920, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(renderFrame(7680, 4320)).toEqual({ width: 3840, height: 2160 });
    expect(renderFrame(6144, 3240)).toEqual({ width: 4096, height: 2160 });
    expect(renderFrame(4320, 5400)).toEqual({ width: 2160, height: 2700 });
  });
});
