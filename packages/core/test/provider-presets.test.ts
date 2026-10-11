import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OpenAICompatibleProvider,
  createTextProvider,
  loadDefaults,
  loadProviderCatalog,
  presetNeedsKey,
  testProvider,
  type TextProvider,
} from "../src/index.js";

const defaults = loadDefaults();

afterEach(() => vi.unstubAllGlobals());

describe("provider presets", () => {
  it("offers only providers that read images", () => {
    for (const p of loadProviderCatalog()) expect(p.capabilities.vision, p.id).not.toBe(false);
  });

  it("connects a preset with its own address, model and image reading", () => {
    const p = createTextProvider(defaults, { provider: "gemini", apiKey: "k" });
    expect(p).toBeInstanceOf(OpenAICompatibleProvider);
    expect(p.name).toBe("gemini");
    expect(p.model).toBe("gemini-3.8-flash");
    expect(p.capabilities.vision).toBe(true);
  });

  it("asks for the address of a custom endpoint", () => {
    expect(() =>
      createTextProvider(defaults, { provider: "custom", model: "m", apiKey: "k" }),
    ).toThrow(/address|base URL/i);
    const p = createTextProvider(defaults, {
      provider: "custom",
      model: "my-model",
      apiKey: "k",
      baseURL: "https://example.invalid/v1",
    });
    expect(p.model).toBe("my-model");
  });

  it("needs no key for a local server", () => {
    const local = loadProviderCatalog().find((p) => p.id === "lmstudio")!;
    expect(presetNeedsKey(local)).toBe(false);
    expect(presetNeedsKey(loadProviderCatalog().find((p) => p.id === "openai")!)).toBe(true);
  });

  it("lists LM Studio's chat models with whether they read images", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe("http://localhost:1234/api/v1/models");
        return new Response(
          JSON.stringify({
            models: [
              {
                type: "llm",
                key: "qwen/qwen3.8-27b",
                display_name: "Qwen3.8 27B",
                max_context_length: 262144,
                capabilities: { vision: true },
              },
              { type: "llm", key: "text-only", capabilities: { vision: false } },
              { type: "embedding", key: "nomic" },
            ],
          }),
        );
      }),
    );
    const p = createTextProvider(defaults, { provider: "lmstudio", model: "qwen/qwen3.8-27b" });
    const models = await p.listModels!();
    expect(models).toEqual([
      { id: "qwen/qwen3.8-27b", displayName: "Qwen3.8 27B", contextWindow: 262144, vision: true },
      { id: "text-only", displayName: "text-only", contextWindow: null, vision: false },
    ]);
  });
});

describe("openrouter", () => {
  it("lists chat models with whether they take images, without batch variants", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe("https://openrouter.ai/api/v1/models");
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "anthropic/claude-opus-5.5",
                name: "Anthropic: Claude Opus 5.5",
                context_length: 1000000,
                architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
              },
              {
                id: "anthropic/claude-opus-5.5:batch",
                architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
              },
              {
                id: "some/text-model",
                architecture: { input_modalities: ["text"], output_modalities: ["text"] },
              },
              {
                id: "some/image-maker",
                architecture: { input_modalities: ["text"], output_modalities: ["image"] },
              },
            ],
          }),
        );
      }),
    );
    const p = createTextProvider(defaults, { provider: "openrouter", apiKey: "k" });
    expect(p.model).toBe("anthropic/claude-opus-5.5");
    expect(await p.listModels!()).toEqual([
      {
        id: "anthropic/claude-opus-5.5",
        displayName: "Anthropic: Claude Opus 5.5",
        contextWindow: 1000000,
        vision: true,
      },
      { id: "some/text-model", displayName: "some/text-model", contextWindow: null, vision: false },
    ]);
  });
});

describe("connection test", () => {
  const answering = (text: string, fail?: Error): TextProvider => ({
    name: "fake",
    model: "m",
    capabilities: { vision: true, structuredOutput: false, contextWindow: 1000 },
    async complete(req) {
      if (fail) throw fail;
      expect(req.messages[0]?.content[0]).toMatchObject({ type: "image", mediaType: "image/png" });
      return { text, model: "m", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  });

  it("passes when the model names the colour of the picture", async () => {
    expect(await testProvider(answering("Red."))).toMatchObject({ ok: true, vision: true });
  });

  it("says when the model answered without seeing the picture", async () => {
    const r = await testProvider(answering("Blue"));
    expect(r).toMatchObject({ ok: true, vision: false });
    expect(r.message).toMatch(/did not see the picture/);
  });

  it("passes the provider's own message on a failure", async () => {
    const r = await testProvider(answering("", new Error("The key was refused.")));
    expect(r).toMatchObject({ ok: false, message: "The key was refused." });
  });
});

describe("inline reasoning", () => {
  it("drops <think> blocks from a reply", async () => {
    const { stripThinking } = await import("../src/index.js");
    expect(stripThinking("<think>The square looks red to me.</think>\nBlue")).toBe("Blue");
    expect(stripThinking("Answer")).toBe("Answer");
    expect(stripThinking("<think>cut off")).toBe("");
  });
});

describe("streamed replies", () => {
  it("joins the pieces, keeps the finish reason, model and usage", async () => {
    const { readChatStream } = await import("../src/index.js");
    const sse = [
      'data: {"model":"grok-4.7","choices":[{"delta":{"role":"assistant","content":""}}]}',
      "",
      ": keep-alive",
      'data: {"choices":[{"delta":{"content":"Re"}}]}',
      'data: {"choices":[{"delta":{"content":"d"},"finish_reason":"stop"}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":2}}',
      "data: [DONE]",
    ].join("\n");
    const r = readChatStream(sse);
    expect(r.choices?.[0]?.message?.content).toBe("Red");
    expect(r.choices?.[0]?.finish_reason).toBe("stop");
    expect(r.model).toBe("grok-4.7");
    expect(r.usage?.completion_tokens).toBe(2);
  });

  it("reports an error sent inside the stream and a cut-off reply", async () => {
    const { readChatStream } = await import("../src/index.js");
    expect(readChatStream('data: {"error":{"message":"overloaded"}}').error?.message).toBe(
      "overloaded",
    );
    const cut = readChatStream(
      'data: {"choices":[{"delta":{"content":"<html"},"finish_reason":"length"}]}',
    );
    expect(cut.choices?.[0]?.finish_reason).toBe("length");
  });
});

describe("retries", () => {
  afterEach(() => vi.unstubAllGlobals());

  const provider = () =>
    new OpenAICompatibleProvider({
      name: "xai",
      baseURL: "https://api.example.test/v1",
      model: "m",
      capabilities: { vision: true, structuredOutput: false, contextWindow: 1000 },
      retryDelayMs: 0,
    });
  const request = {
    system: "s",
    messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
    maxTokens: 10,
    purpose: "test",
  };
  const ok = () =>
    new Response('data: {"choices":[{"delta":{"content":"fine"},"finish_reason":"stop"}]}\n\n', {
      headers: { "content-type": "text/event-stream" },
    });

  it("tries a dropped connection again", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      if (calls === 1)
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      return ok();
    });
    expect((await provider().complete(request)).text).toBe("fine");
    expect(calls).toBe(2);
  });

  it("gives up after three tries, and never retries a refused key", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      throw new TypeError("fetch failed");
    });
    await expect(provider().complete(request)).rejects.toThrow(/Could not reach/);
    expect(calls).toBe(3);

    calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 });
    });
    await expect(provider().complete(request)).rejects.toThrow(/rejected the API key/);
    expect(calls).toBe(1);
  });
});

describe("billed output tokens", () => {
  it("adds reasoning that a provider leaves out of completion_tokens", async () => {
    const { outputTokens } = await import("../src/index.js");
    expect(
      outputTokens({ prompt_tokens: 1297, completion_tokens: 4871, total_tokens: 39444 }),
    ).toBe(38147);
    // MiniMax and OpenAI already count it inside completion_tokens
    expect(outputTokens({ prompt_tokens: 228, completion_tokens: 29, total_tokens: 257 })).toBe(29);
    expect(outputTokens({ prompt_tokens: 10, completion_tokens: 5 })).toBe(5);
  });
});

describe("keys on the command line", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reads a preset's key from KILNFRAME_API_KEY when none is passed", async () => {
    vi.stubEnv("KILNFRAME_API_KEY", "env-key");
    let auth = "";
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      auth = String((init.headers as Record<string, string>).authorization);
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
        {
          headers: { "content-type": "text/event-stream" },
        },
      );
    });
    const p = createTextProvider(defaults, { provider: "gemini", model: "gemini-3.8-flash" });
    await p.complete({
      system: "s",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxTokens: 10,
      purpose: "test",
    });
    expect(auth).toBe("Bearer env-key");
    vi.unstubAllGlobals();
  });
});
