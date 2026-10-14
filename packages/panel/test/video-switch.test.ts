import { describe, expect, it } from "vitest";
import { isOtherVideo, videoBusy } from "../src/video-switch";

describe("switching to another sequence", () => {
  it("starts fresh when another sequence is open and nothing runs", () => {
    expect(isOtherVideo("seq-a", "seq-b", false)).toBe(true);
  });

  it("keeps the screen for the same sequence, the first read, and a running job", () => {
    expect(isOtherVideo("seq-a", "seq-a", false)).toBe(false);
    expect(isOtherVideo(undefined, "seq-a", false)).toBe(false);
    expect(isOtherVideo("seq-a", "seq-b", true)).toBe(false);
  });

  it("counts a job running in the background, a review and a followed job as busy", () => {
    const idle = { screen: "home", reviewing: false, following: false, job: null };
    expect(videoBusy(idle)).toBe(false);
    expect(videoBusy({ ...idle, job: { placed: null, error: null } })).toBe(true);
    expect(videoBusy({ ...idle, job: { placed: { videoTrack: 1 }, error: null } })).toBe(false);
    expect(videoBusy({ ...idle, job: { placed: null, error: "failed" } })).toBe(false);
    expect(videoBusy({ ...idle, screen: "progress" })).toBe(true);
    expect(videoBusy({ ...idle, reviewing: true })).toBe(true);
    expect(videoBusy({ ...idle, following: true })).toBe(true);
  });
});
