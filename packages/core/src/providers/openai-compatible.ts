import type { Price } from "../models.js";
import {
  ProviderError,
  mentionsUnavailableModel,
  type Capabilities,
  type ModelInfo,
  type TextProvider,
  type TextRequest,
  type TextResponse,
} from "./types.js";

export interface OpenAICompatibleOptions {
  name: string;
  baseURL: string;
  model: string;
  apiKey?: string | undefined;
  capabilities: Capabilities;
  /** Extra JSON merged into the request body (provider specific switches). */
  extraBody?: Record<string, unknown>;
  /**
   * OpenRouter's reasoning.effort for a model that otherwise thinks so long it uses the whole output limit
   * (providers.json, reasoningEffort). Unset: nothing is sent and the model thinks as it does by default.
   */
  reasoningEffort?: string | undefined;
  /** Where the thinking level goes: OpenRouter's reasoning.effort (default) or Z.ai's top-level reasoning_effort. */
  reasoningField?: "reasoning" | "reasoning_effort" | undefined;
  /** Pause before a retry, times the attempt number (tests set it to 0). */
  retryDelayMs?: number;
}

interface ChatCompletion {
  model?: string;
  choices?: {
    message?: { content?: string | null };
    /** a streamed chunk carries a piece of the answer here */
    delta?: { content?: string | null };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    /** OpenAI style cache report */
    prompt_tokens_details?: { cached_tokens?: number };
    /** DeepSeek style cache report */
    prompt_cache_hit_tokens?: number;
  };
  error?: { message?: string };
}

/**
 * Any endpoint that speaks the OpenAI Chat Completions format: OpenAI, Gemini, xAI, MiniMax, LM Studio or a custom
 * server. Base URLs live in providers.json.
 */
export class OpenAICompatibleProvider implements TextProvider {
  readonly name: string;
  readonly model: string;
  readonly capabilities: Capabilities;

  constructor(private readonly o: OpenAICompatibleOptions) {
    this.name = o.name;
    this.model = o.model;
    this.capabilities = o.capabilities;
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.name === "lmstudio") return this.listLmStudioModels();
    if (this.name === "openrouter") return this.listOpenRouterModels();
    let res: Response;
    try {
      res = await fetch(`${this.o.baseURL.replace(/\/$/, "")}/models`, {
        headers: this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {},
      });
    } catch {
      throw new ProviderError(`Could not reach ${this.name} at ${this.o.baseURL}.`, true);
    }
    if (!res.ok)
      throw new ProviderError(
        `${this.name} could not list models (${res.status}).`,
        res.status >= 500,
      );
    const body = (await res.json()) as { data?: { id: string; name?: string }[] };
    return (body.data ?? []).map((m) => ({
      id: m.id,
      displayName: m.name ?? m.id,
      contextWindow: null,
      vision: null,
    }));
  }

  /**
   * LM Studio's own list says which models read images (GET /api/v1/models, capabilities.vision; checked
   * against lmstudio.ai/docs/developer/rest/list and a running LM Studio on 8 Oct 2026). Embedding models
   * are left out.
   */
  private async listLmStudioModels(): Promise<ModelInfo[]> {
    const origin = new URL(this.o.baseURL).origin;
    let res: Response;
    try {
      res = await fetch(`${origin}/api/v1/models`);
    } catch {
      throw new ProviderError(
        "LM Studio is not running. Open LM Studio and start its server (Developer tab).",
        true,
      );
    }
    if (!res.ok)
      throw new ProviderError(
        `LM Studio could not list models (${res.status}).`,
        res.status >= 500,
      );
    const body = (await res.json()) as {
      models?: {
        type?: string;
        key: string;
        display_name?: string;
        max_context_length?: number;
        capabilities?: { vision?: boolean };
      }[];
    };
    return (body.models ?? [])
      .filter((m) => m.type === "llm")
      .map((m) => ({
        id: m.key,
        displayName: m.display_name ?? m.key,
        contextWindow: m.max_context_length ?? null,
        vision: m.capabilities?.vision ?? false,
      }));
  }

  /**
   * OpenRouter's public model list says what each model takes (architecture.input_modalities); only chat
   * models are kept, and batch variants left out (checked 8 Oct 2026: 467 models, 297 take images).
   */
  private async listOpenRouterModels(): Promise<ModelInfo[]> {
    let res: Response;
    try {
      res = await fetch(`${this.o.baseURL.replace(/\/$/, "")}/models`);
    } catch {
      throw new ProviderError("Could not reach OpenRouter.", true);
    }
    if (!res.ok)
      throw new ProviderError(
        `OpenRouter could not list models (${res.status}).`,
        res.status >= 500,
      );
    const body = (await res.json()) as {
      data?: {
        id: string;
        name?: string;
        context_length?: number;
        architecture?: { input_modalities?: string[]; output_modalities?: string[] };
        /** USD per token, as strings */
        pricing?: {
          prompt?: string;
          completion?: string;
          input_cache_read?: string;
          input_cache_write?: string;
        };
      }[];
    };
    return (body.data ?? [])
      .filter(
        (m) =>
          !m.id.includes(":") && (m.architecture?.output_modalities ?? ["text"]).includes("text"),
      )
      .map((m) => ({
        id: m.id,
        displayName: m.name ?? m.id,
        contextWindow: m.context_length ?? null,
        vision: (m.architecture?.input_modalities ?? []).includes("image"),
        ...(openRouterPrice(m.pricing) ? { price: openRouterPrice(m.pricing)! } : {}),
      }));
  }

  private priceLookup: Promise<Price | undefined> | undefined;

  /**
   * The model's price from OpenRouter's own list, for models the catalog (models.json) does not know, so a
   * job's usage.json still says what it cost. Read once; undefined for other providers or when it fails.
   */
  modelPrice(): Promise<Price | undefined> {
    if (this.name !== "openrouter") return Promise.resolve(undefined);
    this.priceLookup ??= this.listOpenRouterModels()
      .then((models) => models.find((m) => m.id === this.model)?.price)
      .catch(() => undefined);
    return this.priceLookup;
  }

  /**
   * A dropped connection, a rate limit or a 5xx is tried again, twice, after a short pause: one reset in a
   * six-minute xAI reply used to fail the whole job (8 Oct 2026). The Anthropic SDK does the same on its own.
   * A reply cut off at the output limit is tried only once more: a model that thinks at great length tends to
   * hit the limit again, and each try can take many minutes.
   */
  async complete(req: TextRequest): Promise<TextResponse> {
    let effort = this.o.reasoningEffort;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.once(req, effort);
      } catch (err) {
        if (!(err instanceof ProviderError) || !err.retryable) throw err;
        if (attempt >= (err.kind === "cut-off" ? 2 : 3)) throw err;
        // the thinking counts against the limit: the try again thinks little (where a level is set at all)
        if (err.kind === "cut-off" && effort) effort = "low";
        await new Promise((r) => setTimeout(r, (this.o.retryDelayMs ?? 5_000) * attempt));
      }
    }
  }

  private async once(req: TextRequest, effort?: string): Promise<TextResponse> {
    const messages = [
      { role: "system", content: req.system },
      ...req.messages.map((m) => ({
        role: m.role,
        content: m.content.map((p) =>
          p.type === "text"
            ? { type: "text", text: p.text }
            : { type: "image_url", image_url: { url: `data:${p.mediaType};base64,${p.base64}` } },
        ),
      })),
    ];
    // Streamed: the headers come back at once, so a model that thinks for minutes before it writes does not
    // run into fetch's five-minute wait for them (an xAI scene failed that way on 8 Oct 2026).
    let res: Response;
    try {
      res = await fetch(`${this.o.baseURL.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          max_tokens: req.maxTokens,
          stream: true,
          stream_options: { include_usage: true },
          ...(effort
            ? this.o.reasoningField === "reasoning_effort"
              ? { reasoning_effort: effort }
              : { reasoning: { effort } }
            : {}),
          ...this.o.extraBody,
        }),
      });
    } catch (err) {
      throw new ProviderError(unreachable(this.name, this.o.baseURL, err), true);
    }
    if (res.ok && (res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      let streamed: ChatCompletion;
      try {
        // a stream that stops halfway throws here like a lost connection
        streamed = readChatStream(await res.text());
      } catch (err) {
        throw new ProviderError(unreachable(this.name, this.o.baseURL, err), true);
      }
      return this.answer(streamed, req);
    }
    const raw = (await res.json().catch(() => ({}))) as ChatCompletion | ChatCompletion[];
    // Gemini's OpenAI endpoint sends its error inside an array
    const body = Array.isArray(raw) ? (raw[0] ?? {}) : raw;
    if (!res.ok) {
      const detail = body.error?.message ?? res.statusText;
      // the key is fine but the account must accept something first (OpenRouter's age confirmation, a
      // model's terms): saying the key was rejected sent editors to check a key that worked
      const page = res.status === 401 || res.status === 403 ? needsAcceptance(detail) : null;
      if (page)
        throw new ProviderError(
          `${this.name} asks for something to be accepted on its website first: ${detail} Open ${page}, accept it, then try again.`,
          false,
        );
      if (res.status === 401 || res.status === 403 || /api key/i.test(detail))
        throw new ProviderError(
          `${this.name} rejected the API key. Check it in the settings: ${detail}`,
          false,
        );
      const unavailable =
        res.status === 404 ||
        ((res.status === 400 || res.status === 422) && mentionsUnavailableModel(detail));
      throw new ProviderError(
        unavailable
          ? `${this.name} does not offer the model "${this.model}": ${detail}`
          : `${this.name} error ${res.status}: ${detail}`,
        res.status === 429 || res.status >= 500,
        unavailable ? "model-unavailable" : undefined,
      );
    }
    return this.answer(body, req);
  }

  private answer(body: ChatCompletion, req: TextRequest): TextResponse {
    if (body.error?.message)
      throw new ProviderError(`${this.name} error: ${body.error.message}`, true);
    const choice = body.choices?.[0];
    if (choice?.finish_reason === "length") {
      throw new ProviderError(
        `The reply for ${req.purpose} was cut off at ${req.maxTokens} tokens.`,
        true,
        "cut-off",
      );
    }
    return {
      text: stripThinking(choice?.message?.content ?? ""),
      model: body.model ?? this.model,
      usage: {
        inputTokens: (body.usage?.prompt_tokens ?? 0) - cachedTokens(body.usage),
        cacheReadTokens: cachedTokens(body.usage),
        outputTokens: outputTokens(body.usage),
      },
    };
  }
}

/**
 * Joins a streamed chat completion (server-sent events, one JSON chunk per `data:` line) back into one reply:
 * the text pieces in order, the last finish reason, model and usage (sent in a final chunk when asked for
 * with stream_options.include_usage). An error sent inside the stream comes back as `error`.
 */
export function readChatStream(sse: string): ChatCompletion {
  let text = "";
  let finish: string | null = null;
  const out: ChatCompletion = {};
  for (const line of sse.split("\n")) {
    const data = line.startsWith("data:") ? line.slice(5).trim() : "";
    if (!data || data === "[DONE]") continue;
    let chunk: ChatCompletion;
    try {
      chunk = JSON.parse(data) as ChatCompletion;
    } catch {
      continue;
    }
    if (chunk.error) out.error = chunk.error;
    if (chunk.model) out.model = chunk.model;
    if (chunk.usage) out.usage = chunk.usage;
    const c = chunk.choices?.[0];
    text += c?.delta?.content ?? c?.message?.content ?? "";
    if (c?.finish_reason) finish = c.finish_reason;
  }
  out.choices = [{ message: { content: text }, finish_reason: finish }];
  return out;
}

/** "Could not reach" with the reason fetch gave, so a timeout reads as a timeout. */
function unreachable(name: string, baseURL: string, err: unknown): string {
  const cause = (err as { cause?: { code?: string; message?: string } } | null)?.cause;
  const code = cause?.code ?? "";
  if (/TIMEOUT/i.test(code))
    return `${name} did not answer in time (${code}). The model may be thinking for very long; try again or pick a faster model.`;
  const why = cause?.message ?? (err instanceof Error ? err.message : "");
  return `Could not reach ${name} at ${baseURL}${why ? ` (${why})` : ""}.`;
}

/**
 * Billed output: the answer plus the reasoning. Most providers count reasoning inside completion_tokens;
 * xAI leaves it out and only adds it to total_tokens (8 Oct 2026: 4,871 completion tokens in a total of
 * 39,444 with 1,297 prompt tokens), so whatever the total holds beyond prompt and completion is added.
 */
export function outputTokens(usage: ChatCompletion["usage"]): number {
  const prompt = usage?.prompt_tokens ?? 0;
  const completion = usage?.completion_tokens ?? 0;
  return completion + Math.max(0, (usage?.total_tokens ?? 0) - prompt - completion);
}

/** Prompt tokens served from the provider's cache, which are billed far below fresh input. */
function cachedTokens(usage: ChatCompletion["usage"]): number {
  return usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? 0;
}

/**
 * Some models (MiniMax M3) send their reasoning inline as <think>…</think> before the answer. It is not part
 * of the answer: left in, it breaks the plan's JSON and could make the connection test pass on a colour named
 * while thinking. An unclosed block (cut off) is dropped to the end.
 */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();
}

/** OpenRouter's per-token prices as USD per million; a missing cache price is charged like input. */
function openRouterPrice(p?: {
  prompt?: string;
  completion?: string;
  input_cache_read?: string;
  input_cache_write?: string;
}): Price | undefined {
  const perMillion = (v?: string) => (v === undefined || v === "" ? NaN : Number(v) * 1_000_000);
  const input = perMillion(p?.prompt);
  const output = perMillion(p?.completion);
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0)
    return undefined;
  const cacheRead = perMillion(p?.input_cache_read);
  const cacheWrite = perMillion(p?.input_cache_write);
  return {
    input,
    output,
    cacheRead: Number.isFinite(cacheRead) ? cacheRead : input,
    cacheWrite: Number.isFinite(cacheWrite) ? cacheWrite : input,
  };
}

/** The page to visit when a refusal asks the account to confirm or accept something; null otherwise. */
export function needsAcceptance(detail: string): string | null {
  if (!/\b(confirm|confirmation|accept|complete the following)\b/i.test(detail)) return null;
  const url = /https:\/\/[^\s"')]+/.exec(detail)?.[0];
  return url ? url.replace(/[.,;:]+$/, "") : null;
}
