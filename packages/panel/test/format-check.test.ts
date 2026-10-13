import { describe, expect, it } from "vitest";
import { formatMismatch } from "../src/format-check";

describe("format against the sequence", () => {
  it("warns when the chosen format differs from the sequence's shape", () => {
    expect(formatMismatch("1920x1080", "portrait")).toEqual({
      sequence: "landscape",
      chosen: "portrait",
    });
    expect(formatMismatch("1080x1920", "square")).toEqual({
      sequence: "portrait",
      chosen: "square",
    });
    expect(formatMismatch("1080x1080", "landscape")).toEqual({
      sequence: "square",
      chosen: "landscape",
    });
  });

  it("stays quiet when they match, for Original, and without a size", () => {
    expect(formatMismatch("3840x2160", "landscape")).toBeNull();
    expect(formatMismatch("1080x1920", "orijinal")).toBeNull();
    expect(formatMismatch("", "portrait")).toBeNull();
  });
});
