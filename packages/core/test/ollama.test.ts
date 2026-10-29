import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OpenAICompatibleProvider,
  ProviderError,
  createTextProvider,
  loadDefaults,
  type TextRequest,
} from "../src/index.js";

const caps = { vision: true, structuredOutput: false, contextWindow: 32_000 };
const ok = () =>
  new Response('data: {"choices":[{"delta":{"content":"fine"},"finish_reason":"stop"}]}\n\n', {
    headers: { "content-type": "text/event-stream" },
  });

interface Fake {
  tags: string[];
  show: Record<string, { capabilities: string[]; ctx?: number }>;
  /** running models and their context; a model is loaded by /api/generate at `loadsWith` */
  ps: Record<string, number>;
  loadsWith?: number;
}

/** A fake Ollama: tags, show, ps, generate (loads a model) and chat; records chat bodies and urls. */
function fakeOllama(f: Fake) {
  const bodies: Record<string, unknown>[] = [];
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      urls.push(url);
      const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      if (url.endsWith("/api/tags"))
        return new Response(JSON.stringify({ models: f.tags.map((n) => ({ name: n, model: n })) }));
      if (url.endsWith("/api/show")) {
        const m = f.show[String(body.model)];
        if (!m) return new Response("{}", { status: 404 });
        return new Response(
          JSON.stringify({
            capabilities: m.capabilities,
            model_info: {
              "general.architecture": "qwen3",
              ...(m.ctx ? { "qwen3.context_length": m.ctx } : {}),
            },
          }),
        );
      }
      if (url.endsWith("/api/ps"))
        return new Response(
          JSON.stringify({
            models: Object.entries(f.ps).map(([name, ctx]) => ({
              name,
              model: name,
              context_length: ctx,
            })),
          }),
        );
      if (url.endsWith("/api/generate")) {
        if (f.loadsWith) f.ps[String(body.model)] = f.loadsWith;
        return new Response(JSON.stringify({ done: true }));
      }
      bodies.push(body);
      return ok();
    }),
  );
  return { bodies, urls };
}

function ollama(model: string, thinking?: "on" | "off") {
  return new OpenAICompatibleProvider({
    name: "ollama",
    baseURL: "http://localhost:11434/v1",
    model,
    capabilities: caps,
    retryDelayMs: 0,
    log: () => undefined,
    ...(thinking ? { thinking } : {}),
  });
}

const req = (chars: number, maxTokens = 64_000): TextRequest => ({
  system: "",
  messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(chars) }] }],
  maxTokens,
  purpose: "compose s1",
});

afterEach(() => vi.unstubAllGlobals());

describe("Ollama", () => {
  it("lists only models that read images, with their context, which are loaded and which think", async () => {
    fakeOllama({
      tags: ["qwen3.8-vl:27b", "llama3.3:70b"],
      show: {
        "qwen3.8-vl:27b": { capabilities: ["completion", "vision", "thinking"], ctx: 262_144 },
        "llama3.3:70b": { capabilities: ["completion"], ctx: 131_072 },
      },
      ps: { "qwen3.8-vl:27b": 65_536 },
    });
    const models = await ollama("qwen3.8-vl:27b").listModels();
    expect(models).toEqual([
      {
        id: "qwen3.8-vl:27b",
        displayName: "qwen3.8-vl:27b",
        contextWindow: 262_144,
        vision: true,
        loaded: true,
        loadedContext: 65_536,
        reasons: true,
      },
      {
        id: "llama3.3:70b",
        displayName: "llama3.3:70b",
        contextWindow: 131_072,
        vision: false,
        loaded: false,
        loadedContext: null,
        reasons: false,
      },
    ]);
  });

  it("says Ollama is not running when it cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("ECONNREFUSED"))),
    );
    await expect(ollama("m").listModels()).rejects.toThrow(/Ollama is not running/);
  });

  it("loads a model that is not running to read the context it really has", async () => {
    const { urls } = fakeOllama({
      tags: ["m"],
      show: { m: { capabilities: ["completion", "vision"], ctx: 262_144 } },
      ps: {},
      loadsWith: 4096,
    });
    expect(await ollama("m").loadedContext()).toBe(4096);
    expect(urls.some((u) => u.endsWith("/api/generate"))).toBe(true);
  });

  it("stops before sending when Ollama's context is too small, instead of letting Ollama cut the prompt", async () => {
    const { bodies } = fakeOllama({
      tags: ["m"],
      show: { m: { capabilities: ["completion", "vision"] } },
      ps: { m: 4096 },
    });
    const err = await ollama("m")
      .complete(req(40_000))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as Error).message).toMatch(/context in Ollama is too small/);
    expect(bodies).toHaveLength(0);
  });

  it("fits the reply into the loaded context", async () => {
    const { bodies } = fakeOllama({
      tags: ["m"],
      show: { m: { capabilities: ["vision"] } },
      ps: { m: 65_536 },
    });
    await ollama("m").complete(req(4_000));
    expect(Number(bodies[0]!.max_tokens)).toBeLessThan(65_536);
    expect(Number(bodies[0]!.max_tokens)).toBeGreaterThan(30_000);
  });

  it("turns thinking off with reasoning_effort none for a model that thinks, unless asked on", async () => {
    const f = {
      tags: ["m"],
      show: { m: { capabilities: ["vision", "thinking"] } },
      ps: { m: 65_536 },
    };
    let fake = fakeOllama(f);
    await ollama("m").complete(req(100));
    expect(fake.bodies[0]!.reasoning_effort).toBe("none");
    fake = fakeOllama(f);
    await ollama("m", "on").complete(req(100));
    expect(fake.bodies[0]).not.toHaveProperty("reasoning_effort");
  });

  it("is offered as a provider with Ollama's address and no key", () => {
    const p = createTextProvider(loadDefaults(), { provider: "ollama", model: "m" });
    expect(p.name).toBe("ollama");
  });
});

describe("Ollama context it cannot read", () => {
  it("stops with a clear message instead of sending a prompt Ollama may cut, and asks again next time", async () => {
    const f = {
      tags: ["m"],
      show: { m: { capabilities: ["vision"] } },
      ps: {} as Record<string, number>,
    };
    // an Ollama that reports no context_length in /api/ps
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/ps"))
          return new Response(JSON.stringify({ models: [{ name: "m" }] }));
        if (url.endsWith("/api/show"))
          return new Response(JSON.stringify({ capabilities: ["vision"] }));
        if (url.endsWith("/api/generate")) return new Response("{}");
        return ok();
      }),
    );
    void f;
    const p = ollama("m");
    const err = await p.complete(req(100)).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(
      /could not read the context Ollama runs the model with/i,
    );
    // a later try reads again rather than keeping the failure
    fakeOllama({ tags: ["m"], show: { m: { capabilities: ["vision"] } }, ps: { m: 65_536 } });
    await expect(p.complete(req(100))).resolves.toBeDefined();
  });
});
