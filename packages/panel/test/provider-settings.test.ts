import { describe, expect, it } from "vitest";
import { cleanProviderSettings, offersAddress, presetModel } from "../src/provider-settings";

const list = [
  { id: "openai", models: ["gpt-a", "gpt-b"], requires: [] },
  { id: "openrouter", models: ["x/y"], requires: [] },
  { id: "lmstudio", models: [], requires: [] },
  { id: "needs", models: ["m"], requires: ["baseURL"] },
];

describe("provider settings", () => {
  it("offers an address only for the custom endpoint and presets that need one", () => {
    expect(offersAddress("custom", undefined)).toBe(true);
    expect(offersAddress("openai", list[0])).toBe(false);
    expect(offersAddress("lmstudio", list[2])).toBe(false);
    expect(offersAddress("needs", list[3])).toBe(true);
  });

  it("drops a custom address and model copied onto a preset", () => {
    const cleaned = cleanProviderSettings(
      {
        baseURLs: { custom: "http://mine/v1", openai: "http://mine/v1", lmstudio: "http://x" },
        models: { custom: "my-model", openai: "my-model", openrouter: "any/model", lmstudio: "q" },
      },
      list,
    );
    expect(cleaned.baseURLs).toEqual({ custom: "http://mine/v1" });
    expect(cleaned.models).toEqual({ custom: "my-model", openrouter: "any/model", lmstudio: "q" });
  });

  it("keeps a preset's offered model and falls back to its default otherwise", () => {
    expect(presetModel("openai", "gpt-b", list[0])).toBe("gpt-b");
    expect(presetModel("openai", "my-model", list[0])).toBe("gpt-a");
    expect(presetModel("openai", undefined, list[0])).toBe("gpt-a");
    expect(presetModel("openrouter", "any/model", list[1])).toBe("any/model");
    // the list is not known yet: the saved choice stands
    expect(presetModel("openai", "gpt-b", undefined)).toBe("gpt-b");
  });
});
