import { describe, expect, it } from "vitest";
import {
  ProviderError,
  createTextProvider,
  loadDefaults,
  mentionsUnavailableModel,
  presetModel,
  resolveModels,
  withModelFallback,
  type TextProvider,
} from "../src/index.js";

const defaults = loadDefaults();
const MINIMAX = "https://api.minimax.io/v1";

function fake(model: string, fail?: ProviderError): TextProvider & { calls: number } {
  const p = {
    name: "fake",
    model,
    calls: 0,
    capabilities: { vision: false, structuredOutput: false, contextWindow: 1000 },
    async complete() {
      p.calls++;
      if (fail) throw fail;
      return { text: model, model, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  return p;
}

describe("model choice per provider", () => {
  it("uses the Claude defaults only for Claude providers", () => {
    expect(resolveModels("claude-code", defaults, {})).toEqual({
      model: "claude-opus-5-5",
      main: "claude-opus-5-5",
    });
    expect(resolveModels("anthropic", defaults, { purpose: "suggest" })).toEqual({
      model: "claude-sonnet-5-5",
      main: "claude-opus-5-5",
    });
  });

  it("gives an API-key provider its own model, never a Claude name", () => {
    expect(presetModel(`${MINIMAX}/`)).toBe("MiniMax-M3");
    expect(resolveModels("openai-compatible", defaults, {}, MINIMAX)).toEqual({
      model: "MiniMax-M3",
      main: "MiniMax-M3",
    });
    // side tasks use the active model, not the Claude suggestion model
    expect(
      resolveModels(
        "openai-compatible",
        defaults,
        { purpose: "suggest", model: "MiniMax-M2.7" },
        MINIMAX,
      ),
    ).toEqual({ model: "MiniMax-M2.7", main: "MiniMax-M2.7" });
    const p = createTextProvider(defaults, {
      provider: "openai-compatible",
      baseURL: MINIMAX,
      purpose: "suggest",
    });
    expect(p.model).toBe("MiniMax-M3");
  });

  it("asks for a model when a custom endpoint has none", () => {
    expect(() =>
      resolveModels("openai-compatible", defaults, {}, "http://localhost:9999/v1"),
    ).toThrow(/Pick a model/);
  });
});

describe("model fallback", () => {
  it("falls back once to the main model when the provider lacks the side model", async () => {
    const missing = new ProviderError("no such model", false, "model-unavailable");
    const side = fake("claude-sonnet-5-5", missing);
    const main = fake("claude-opus-5-5");
    const notes: string[] = [];
    const p = withModelFallback(
      side,
      () => main,
      (m) => notes.push(m),
    );
    const res = await p.complete({
      system: "",
      messages: [],
      maxTokens: 10,
      purpose: "suggest styles",
    });
    expect(res.model).toBe("claude-opus-5-5");
    expect(p.model).toBe("claude-opus-5-5");
    expect(notes[0]).toMatch(/claude-sonnet-5-5 is not available here; using claude-opus-5-5/);
    await p.complete({ system: "", messages: [], maxTokens: 10, purpose: "again" });
    expect(side.calls).toBe(1);
  });

  it("does not hide other errors such as a rejected key", async () => {
    const p = withModelFallback(fake("a", new ProviderError("key rejected", false)), () =>
      fake("b"),
    );
    await expect(
      p.complete({ system: "", messages: [], maxTokens: 10, purpose: "x" }),
    ).rejects.toThrow(/key rejected/);
  });

  it("recognises 'model not found' messages from providers", () => {
    expect(mentionsUnavailableModel("The model `claude-sonnet-5-5` does not exist")).toBe(true);
    expect(mentionsUnavailableModel("invalid model: MiniMax-X")).toBe(true);
    expect(mentionsUnavailableModel("model_not_found")).toBe(true);
    // Claude Code's own wording (checked 7 Oct 2026)
    expect(
      mentionsUnavailableModel(
        "There's an issue with the selected model (claude-x). It may not exist or you may not have access to it.",
      ),
    ).toBe(true);
    expect(mentionsUnavailableModel("Rate limit reached")).toBe(false);
  });
});
