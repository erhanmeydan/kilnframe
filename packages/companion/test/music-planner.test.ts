import { describe, expect, it } from "vitest";
import { loadDefaults } from "@kilnframe/core";
import { MemoryKeyStore } from "../src/keys.js";
import { musicTextProvider } from "../src/runner.js";

describe("musicTextProvider", () => {
  it("writes music plans with the Gemini model on the music key, not the chosen text model", async () => {
    const defaults = loadDefaults();
    const keys = new MemoryKeyStore();
    await keys.set("gemini", "test-key");
    await keys.set("anthropic", "other-key");
    const p = await musicTextProvider(defaults, keys);
    expect(p.name).toBe(defaults.music.planner.provider);
    expect(p.model).toBe(defaults.music.planner.model);
    expect(p.name).toBe("gemini");
  });

  it("says a Google key is needed when there is none", async () => {
    await expect(musicTextProvider(loadDefaults(), new MemoryKeyStore())).rejects.toThrow(/Gemini/);
  });
});
