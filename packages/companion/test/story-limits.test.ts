import { describe, expect, it } from "vitest";
import { JobParamsSchema } from "../src/protocol.js";

describe("story-write limits", () => {
  it("takes a long brief, such as a pasted article to tell as a story", () => {
    const r = JobParamsSchema.safeParse({
      kind: "story-write",
      brief: "a".repeat(12000),
      durationS: 60,
      language: "tr",
    });
    expect(r.success).toBe(true);
  });
});
