import { describe, expect, it } from "vitest";
import { isOtherVideo } from "../src/video-switch";

describe("switching to another sequence", () => {
  it("starts fresh when another sequence is open and nothing runs", () => {
    expect(isOtherVideo("seq-a", "seq-b", false)).toBe(true);
  });

  it("keeps the screen for the same sequence, the first read, and a running job", () => {
    expect(isOtherVideo("seq-a", "seq-a", false)).toBe(false);
    expect(isOtherVideo(undefined, "seq-a", false)).toBe(false);
    expect(isOtherVideo("seq-a", "seq-b", true)).toBe(false);
  });
});
