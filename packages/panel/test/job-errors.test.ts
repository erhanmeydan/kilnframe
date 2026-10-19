import { describe, expect, it } from "vitest";
import { readableJobError } from "../src/job-errors";

const failed = `The composition still fails validation after 3 repair rounds:
- overlay_faint_layer: Overlay scene s2: 83% of the frame is covered by an almost invisible layer (alpha 8% or less) at 14.60 s.
- scene_shows_nothing: Scene s3 shows nothing at 20.00 s.
- some_lint_rule: something else`;

describe("job errors in the panel's language", () => {
  it("turns a failed validation into a plain sentence with the reasons it knows", () => {
    expect(readableJobError(failed)).toEqual({
      key: "job.checksFailed",
      vars: { n: 3 },
      reasons: ["check.overlay_faint_layer", "check.scene_shows_nothing"],
    });
  });

  it("says an expired API key plainly, with the provider's name", () => {
    expect(
      readableJobError(
        "openrouter rejected the API key. Check it in the settings: API key expired.",
      ),
    ).toEqual({ key: "job.keyExpired", vars: { provider: "OpenRouter" }, reasons: [] });
  });

  it("says any other rejected key in the panel's language", () => {
    expect(
      readableJobError("xai rejected the API key. Check it in the settings: Incorrect API key"),
    ).toEqual({ key: "job.keyRejected", vars: { provider: "xAI" }, reasons: [] });
    expect(readableJobError("acme rejected the API key. Check it in the settings: nope")).toEqual({
      key: "job.keyRejected",
      vars: { provider: "acme" },
      reasons: [],
    });
  });

  it("leaves any other message as it is", () => {
    expect(readableJobError("OpenRouter error 500: down")).toBeNull();
  });
});
