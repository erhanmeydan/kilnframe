import { describe, expect, it } from "vitest";
import { readableJobError } from "../src/job-errors";
import en from "../src/locales/en.json";
import tr from "../src/locales/tr.json";

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

  it("says a local model's context was too small, also inside a scene's failure", () => {
    const message =
      "The model's context in LM Studio is too small for compose s1 (38000 tokens loaded, about 36000 needed for the request alone). Load the model in LM Studio with a longer context (at least 64K) or choose a shorter range.";
    expect(readableJobError(message)).toEqual({
      key: "job.contextTooSmall",
      vars: {},
      reasons: [],
    });
    expect(readableJobError(`Scene s1 failed: ${message}`)?.key).toBe("job.contextTooSmall");
  });

  it("has the context sentence in both languages, without dashes in Turkish", () => {
    expect(en["job.contextTooSmall"]).toContain("64K");
    expect(tr["job.contextTooSmall"]).toContain("64K");
    expect(tr["job.contextTooSmall"]).not.toMatch(/[\u2013\u2014]/);
  });

  it("leaves any other message as it is", () => {
    expect(readableJobError("OpenRouter error 500: down")).toBeNull();
  });

  it("says a Gemini key's free tier daily limit, with about how long until it resets", () => {
    const message =
      'gemini error 429: {"error":{"code":429,"message":"You exceeded your current quota. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.8-flash\nPlease retry in 9h33m12.5s."}}';
    expect(readableJobError(message)).toEqual({
      key: "job.geminiFreeTier",
      vars: { limit: 20, hours: 10 },
      reasons: [],
    });
  });

  it("says a free tier limit without a wait when Google gives none", () => {
    expect(
      readableJobError("gemini error 429: generate_content_free_tier_requests, limit: 20"),
    ).toEqual({ key: "job.geminiFreeTierNoWait", vars: { limit: 20 }, reasons: [] });
  });

  it("says Lyria is not on the free tier", () => {
    expect(
      readableJobError(
        "Lyria failed (429): Quota exceeded, limit: 0 requests per day on Free Tier",
      ),
    ).toEqual({ key: "job.lyriaFreeTier", vars: {}, reasons: [] });
  });

  it("has every new message in both languages", () => {
    for (const k of ["job.geminiFreeTier", "job.geminiFreeTierNoWait", "job.lyriaFreeTier"]) {
      expect(en).toHaveProperty(k);
      expect(tr).toHaveProperty(k);
    }
  });

  it("says Ollama's context was too small, with Ollama's own fix", () => {
    expect(
      readableJobError(
        "The model's context in Ollama is too small for compose s1 (4096 tokens loaded, about 9000 needed for the request alone). Set Ollama's context length to at least 64K",
      ),
    ).toEqual({ key: "job.contextTooSmallOllama", vars: {}, reasons: [] });
    expect(en).toHaveProperty("job.contextTooSmallOllama");
    expect(tr).toHaveProperty("job.contextTooSmallOllama");
  });
});
