import { describe, expect, it } from "vitest";
import { capturedFrames } from "../src/hyperframes.js";

describe("capturedFrames", () => {
  it("reads the frames HyperFrames has captured", () => {
    expect(
      capturedFrames('@hf-progress {"code":"capture","done":107,"total":125,"pct":64}'),
    ).toEqual({
      done: 107,
      total: 125,
    });
  });

  it("ignores other stages and other lines", () => {
    expect(
      capturedFrames('@hf-progress {"code":"encode","done":110,"total":125,"pct":88}'),
    ).toBeNull();
    expect(capturedFrames('@hf-progress {"code":"compile","pct":5}')).toBeNull();
    expect(capturedFrames("@hf-progress {broken")).toBeNull();
    expect(capturedFrames("[INFO] [Render] Pipeline started")).toBeNull();
  });
});
