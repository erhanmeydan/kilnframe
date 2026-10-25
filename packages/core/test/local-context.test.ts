import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHARS_PER_TOKEN,
  CONTEXT_SAFETY_TOKENS,
  OpenAICompatibleProvider,
  ProviderError,
  TOKENS_PER_IMAGE,
  UsageMeter,
  estimatePromptTokens,
  type TextRequest,
} from "../src/index.js";

const MODEL = "qwen/qwen3.8-27b";
const caps = { vision: true, structuredOutput: false, contextWindow: 32_000 };

/** LM Studio's GET /api/v1/models with the model loaded at `loaded` tokens (or not loaded). */
function modelList(loaded: number | null, max = 262_144) {
  return {
    models: [
      { type: "embedding", key: "nomic", max_context_length: 2048, loaded_instances: [] },
      {
        type: "llm",
        key: MODEL,
        max_context_length: max,
        capabilities: { vision: true },
        loaded_instances:
          loaded === null ? [] : [{ id: MODEL, config: { context_length: loaded } }],
      },
    ],
  };
}

const ok = () =>
  new Response('data: {"choices":[{"delta":{"content":"fine"},"finish_reason":"stop"}]}\n\n', {
    headers: { "content-type": "text/event-stream" },
  });

/** A fake LM Studio: the model list, then chat replies; records each chat body. */
function fakeLmStudio(list: unknown, chat: () => Response = ok) {
  const bodies: Record<string, unknown>[] = [];
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      urls.push(url);
      if (url.endsWith("/api/v1/models")) return new Response(JSON.stringify(list));
      bodies.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
      return chat();
    }),
  );
  return { bodies, urls };
}

function lmstudio(log: string[] = []) {
  return new OpenAICompatibleProvider({
    name: "lmstudio",
    baseURL: "http://localhost:1234/v1",
    model: MODEL,
    capabilities: caps,
    retryDelayMs: 0,
    log: (line) => log.push(line),
  });
}

function request(chars: number, maxTokens = 64_000, images = 0): TextRequest {
  return {
    system: "",
    messages: [
      {
        role: "user",
        content: [
          ...Array.from({ length: images }, () => ({
            type: "image" as const,
            mediaType: "image/png" as const,
            base64: "AAAA",
          })),
          { type: "text", text: "x".repeat(chars) },
        ],
      },
    ],
    maxTokens,
    purpose: "compose s1",
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("prompt estimate", () => {
  it("counts characters over CHARS_PER_TOKEN and a fixed cost per image", () => {
    const req = request(7_000, 100, 2);
    req.system = "y".repeat(3_500);
    expect(estimatePromptTokens(req)).toBe(
      Math.ceil((7_000 + 3_500) / CHARS_PER_TOKEN) + 2 * TOKENS_PER_IMAGE,
    );
  });
});

describe("LM Studio's loaded context", () => {
  it("uses the context the model was loaded with, read once per provider", async () => {
    const { urls } = fakeLmStudio(modelList(38_000));
    const p = lmstudio();
    expect(await p.loadedContext()).toBe(38_000);
    expect(await p.loadedContext()).toBe(38_000);
    expect(urls.filter((u) => u === "http://localhost:1234/api/v1/models")).toHaveLength(1);
  });

  it("falls back to the model's max context when it is not loaded", async () => {
    fakeLmStudio(modelList(null, 131_072));
    expect(await lmstudio().loadedContext()).toBe(131_072);
  });

  it("knows nothing when LM Studio cannot be asked, and nothing for other providers", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    expect(await lmstudio().loadedContext()).toBeUndefined();
    const cloud = new OpenAICompatibleProvider({
      name: "gemini",
      baseURL: "https://example.test/v1",
      model: "m",
      capabilities: caps,
    });
    expect(await cloud.loadedContext()).toBeUndefined();
  });

  it("passes through the usage meter", async () => {
    fakeLmStudio(modelList(38_000));
    expect(await new UsageMeter().wrap(lmstudio()).loadedContext?.()).toBe(38_000);
  });
});

describe("LM Studio's reply limit", () => {
  it("asks for no more than the loaded context leaves, and logs the request", async () => {
    const { bodies } = fakeLmStudio(modelList(38_000));
    const log: string[] = [];
    await lmstudio(log).complete(request(35_000));
    const prompt = Math.ceil(35_000 / CHARS_PER_TOKEN);
    expect(bodies[0]!.max_tokens).toBe(38_000 - prompt - CONTEXT_SAFETY_TOKENS);
    expect(log).toEqual([
      `LM Studio compose s1: prompt about ${prompt} tokens, max_tokens ${38_000 - prompt - CONTEXT_SAFETY_TOKENS}, context 38000`,
    ]);
  });

  it("keeps a smaller asked limit", async () => {
    const { bodies } = fakeLmStudio(modelList(38_000));
    await lmstudio().complete(request(1_000, 600));
    expect(bodies[0]!.max_tokens).toBe(600);
  });

  it("sends as asked when the context is unknown", async () => {
    const { bodies } = fakeLmStudio({ models: [] });
    const log: string[] = [];
    await lmstudio(log).complete(request(1_000));
    expect(bodies[0]!.max_tokens).toBe(64_000);
    expect(log[0]).toContain("context unknown");
  });

  it("fails early, without sending, when the prompt leaves too little room", async () => {
    const { bodies } = fakeLmStudio(modelList(38_000));
    const err = await lmstudio()
      .complete(request(110_000))
      .catch((e: unknown) => e);
    expect(bodies).toHaveLength(0);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe("context-exceeded");
    expect((err as ProviderError).retryable).toBe(false);
    expect((err as Error).message).toMatch(/^The model's context in LM Studio is too small/);
    expect((err as Error).message).toContain("at least 64K");
  });
});

describe("LM Studio's context error", () => {
  it("turns LM Studio's own context error into the readable one, without retrying", async () => {
    let calls = 0;
    fakeLmStudio(modelList(38_000), () => {
      calls++;
      return new Response(
        JSON.stringify({ error: { message: "Context size has been exceeded." } }),
        {
          status: 400,
        },
      );
    });
    const err = await lmstudio()
      .complete(request(1_000))
      .catch((e: unknown) => e);
    expect(calls).toBe(1);
    expect((err as ProviderError).kind).toBe("context-exceeded");
    expect((err as Error).message).toMatch(/^The model's context in LM Studio is too small/);
  });

  it("recognises the error inside a stream too", async () => {
    fakeLmStudio(
      modelList(38_000),
      () =>
        new Response(
          'data: {"error":{"message":"The number of tokens to keep from the initial prompt is greater than the context length"}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const err = await lmstudio()
      .complete(request(1_000))
      .catch((e: unknown) => e);
    expect((err as ProviderError).kind).toBe("context-exceeded");
  });
});

describe("cloud providers are left as they were", () => {
  it("send the same body, ask nothing about context and log nothing", async () => {
    const urls: string[] = [];
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
      urls.push(url);
      bodies.push(JSON.parse(init.body));
      return ok();
    });
    const log: string[] = [];
    for (const name of ["gemini", "openrouter", "custom"])
      await new OpenAICompatibleProvider({
        name,
        baseURL: "https://example.test/v1",
        model: "m",
        capabilities: { ...caps, contextWindow: 8_000 },
        log: (line) => log.push(line),
      }).complete(request(200_000));
    expect(urls).toEqual(Array(3).fill("https://example.test/v1/chat/completions"));
    for (const body of bodies)
      expect(body).toEqual({
        model: "m",
        messages: [
          { role: "system", content: "" },
          { role: "user", content: [{ type: "text", text: "x".repeat(200_000) }] },
        ],
        max_tokens: 64_000,
        stream: true,
        stream_options: { include_usage: true },
      });
    expect(log).toEqual([]);
  });

  it("keep their own error text for a context message", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ error: { message: "Context size has been exceeded." } }), {
          status: 400,
        }),
    );
    const err = await new OpenAICompatibleProvider({
      name: "gemini",
      baseURL: "https://example.test/v1",
      model: "m",
      capabilities: caps,
    })
      .complete(request(10))
      .catch((e: unknown) => e);
    expect((err as Error).message).toBe("gemini error 400: Context size has been exceeded.");
    expect((err as ProviderError).kind).toBeUndefined();
  });
});
