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
  /**
   * LM Studio only: "off" (the default) sends reasoning_effort "none" to a model that thinks, "on" leaves the
   * model's own default. Other providers never get it.
   */
  thinking?: "off" | "on" | undefined;
  /** Where LM Studio's per-request token line goes (the companion's log through stderr by default). */
  log?: (line: string) => void;
}

/** Characters per token in the prompt estimate: a rough average over English, Turkish, HTML and JSON. */
export const CHARS_PER_TOKEN = 3.5;
/** What one image counts for in the estimate: a style still or a footage frame at the sizes sent. */
export const TOKENS_PER_IMAGE = 1_500;
/** Room kept free between the estimated prompt plus the reply and the context: the estimate is rough. */
export const CONTEXT_SAFETY_TOKENS = 2_000;
/** A local request that leaves less than this for the reply is not sent: no scene fits in it. */
export const MIN_REPLY_TOKENS = 6_000;

/** The request's size in tokens, roughly: its characters over CHARS_PER_TOKEN plus TOKENS_PER_IMAGE each. */
export function estimatePromptTokens(req: TextRequest): number {
  let chars = req.system.length;
  let images = 0;
  for (const m of req.messages)
    for (const p of m.content) {
      if (p.type === "text") chars += p.text.length;
      else images++;
    }
  return Math.ceil(chars / CHARS_PER_TOKEN) + images * TOKENS_PER_IMAGE;
}

/** LM Studio's own words when a request does not fit the loaded context. */
const CONTEXT_EXCEEDED =
  /context (size|length|window)\b[^.]{0,80}?(exceed|not enough|too small)|exceeds? the (available )?context|greater than the context length/i;

/** The readable failure for a request that does not fit the context LM Studio loaded the model with. */
function contextTooSmall(detail: string): ProviderError {
  return new ProviderError(
    `The model's context in LM Studio is too small for ${detail}. Load the model in LM Studio with a longer context (at least 64K) or choose a shorter range.`,
    false,
    "context-exceeded",
  );
}

/** A model in LM Studio's GET /api/v1/models (https://lmstudio.ai/docs/developer/rest/list). */
interface LmStudioModel {
  type?: string;
  key: string;
  display_name?: string;
  max_context_length?: number | null;
  loaded_instances?: { id?: string; config?: { context_length?: number } }[];
  /** reasoning is there only for a model whose thinking can be set */
  capabilities?: { vision?: boolean; reasoning?: { allowed_options?: string[]; default?: string } };
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
    const body = (await res.json()) as { models?: LmStudioModel[] };
    return (body.models ?? [])
      .filter((m) => m.type === "llm")
      .map((m) => ({
        id: m.key,
        displayName: m.display_name ?? m.key,
        contextWindow: m.max_context_length ?? null,
        vision: m.capabilities?.vision ?? false,
        loaded: (m.loaded_instances ?? []).length > 0,
        loadedContext: m.loaded_instances?.[0]?.config?.context_length ?? null,
        reasons: canTurnThinkingOff(m),
      }));
  }

  /** Set once LM Studio has refused reasoning_effort, so later requests leave it out. */
  private reasoningRefused = false;

  private modelLookup: Promise<LmStudioModel | undefined> | undefined;

  /** This model's entry in LM Studio's list, read once; undefined when it cannot be read. */
  private lmStudioModel(): Promise<LmStudioModel | undefined> {
    this.modelLookup ??= this.readLmStudioModel().catch(() => undefined);
    return this.modelLookup;
  }

  private async readLmStudioModel(): Promise<LmStudioModel | undefined> {
    const res = await fetch(`${new URL(this.o.baseURL).origin}/api/v1/models`);
    if (!res.ok) return undefined;
    const body = (await res.json()) as { models?: LmStudioModel[] };
    return (body.models ?? []).find(
      (m) => m.key === this.model || m.loaded_instances?.some((i) => i.id === this.model),
    );
  }

  /**
   * The context LM Studio loaded the model with (loaded_instances[].config.context_length), else the model's
   * max_context_length when it is not loaded yet, from GET /api/v1/models as documented on
   * https://lmstudio.ai/docs/developer/rest/list. Read once; undefined for other providers or when LM Studio
   * cannot be asked.
   */
  async loadedContext(): Promise<number | undefined> {
    if (this.name !== "lmstudio") return undefined;
    const model = await this.lmStudioModel();
    if (!model) return undefined;
    const loaded = (model.loaded_instances ?? [])
      .filter((i) => i.id === this.model || model.key === this.model)
      .map((i) => i.config?.context_length)
      .filter((n): n is number => typeof n === "number" && n > 0);
    // loaded more than once: the smallest, so the request fits whichever instance answers
    if (loaded.length) return Math.min(...loaded);
    return model.max_context_length ?? undefined;
  }

  /**
   * The reply limit to send. Cloud providers get the stage's own. LM Studio gets no more than its loaded
   * context leaves after the prompt, and a request that would leave less than MIN_REPLY_TOKENS fails here
   * instead of being cut short by LM Studio; one line per request goes to the log.
   */
  private async replyLimit(req: TextRequest): Promise<number> {
    if (this.name !== "lmstudio") return req.maxTokens;
    const log = this.o.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
    const context = await this.loadedContext();
    const prompt = estimatePromptTokens(req);
    if (context === undefined) {
      log(
        `LM Studio ${req.purpose}: prompt about ${prompt} tokens, max_tokens ${req.maxTokens}, context unknown`,
      );
      return req.maxTokens;
    }
    const room = context - prompt - CONTEXT_SAFETY_TOKENS;
    if (room < Math.min(MIN_REPLY_TOKENS, req.maxTokens))
      throw contextTooSmall(
        `${req.purpose} (${context} tokens loaded, about ${prompt} needed for the request alone)`,
      );
    const limit = Math.min(req.maxTokens, room);
    log(
      `LM Studio ${req.purpose}: prompt about ${prompt} tokens, max_tokens ${limit}, context ${context}`,
    );
    return limit;
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
        // the thinking counts against the limit: the try again thinks little (OpenRouter takes the level
        // for any model; elsewhere only where the preset sets one)
        if (err.kind === "cut-off" && (effort || this.name === "openrouter")) effort = "low";
        await new Promise((r) => setTimeout(r, (this.o.retryDelayMs ?? 5_000) * attempt));
      }
    }
  }

  /**
   * LM Studio's switch for a model that thinks: reasoning_effort "none" turns the thinking off on
   * /v1/chat/completions (LM Studio 0.4.8 added reasoning_effort, https://lmstudio.ai/changelog/lmstudio/lmstudio-v0.4.8;
   * it accepts none, minimal, low, medium, high and xhigh, and refuses "off"). Sent only when the model's
   * reasoning options include "off", thinking is not on and LM Studio has not refused the field before;
   * nothing for other providers.
   */
  private async thinkingOff(): Promise<boolean> {
    if (this.name !== "lmstudio" || this.o.thinking === "on" || this.reasoningRefused) return false;
    const model = await this.lmStudioModel();
    return model !== undefined && canTurnThinkingOff(model);
  }

  private async once(req: TextRequest, effort?: string): Promise<TextResponse> {
    const maxTokens = await this.replyLimit(req);
    const noThinking = await this.thinkingOff();
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
    const send = (withNoThinking: boolean) =>
      fetch(`${this.o.baseURL.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          max_tokens: maxTokens,
          stream: true,
          stream_options: { include_usage: true },
          ...(effort
            ? this.o.reasoningField === "reasoning_effort"
              ? { reasoning_effort: effort }
              : { reasoning: { effort } }
            : {}),
          ...(withNoThinking ? { reasoning_effort: "none" } : {}),
          ...this.o.extraBody,
        }),
      });
    let res: Response;
    try {
      res = await send(noThinking);
      // a version of LM Studio that refuses reasoning_effort: ask again without it, and not again later
      if (noThinking && res.status === 400) {
        const refusal = await res
          .clone()
          .text()
          .catch(() => "");
        if (/reasoning/i.test(refusal)) {
          this.reasoningRefused = true;
          (this.o.log ?? ((line: string) => void process.stderr.write(`${line}\n`)))(
            `LM Studio ${req.purpose}: reasoning_effort refused, asking again without it`,
          );
          res = await send(false);
        }
      }
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
      return this.answer(streamed, req, maxTokens);
    }
    const raw = (await res.json().catch(() => ({}))) as ChatCompletion | ChatCompletion[];
    // Gemini's OpenAI endpoint sends its error inside an array
    const body = Array.isArray(raw) ? (raw[0] ?? {}) : raw;
    if (!res.ok) {
      const detail = body.error?.message ?? res.statusText;
      if (this.name === "lmstudio" && CONTEXT_EXCEEDED.test(detail))
        throw contextTooSmall(`${req.purpose}: ${detail.replace(/[.\s]+$/, "")}`);
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
    return this.answer(body, req, maxTokens);
  }

  private answer(body: ChatCompletion, req: TextRequest, maxTokens: number): TextResponse {
    if (body.error?.message) {
      if (this.name === "lmstudio" && CONTEXT_EXCEEDED.test(body.error.message))
        throw contextTooSmall(`${req.purpose}: ${body.error.message.replace(/[.\s]+$/, "")}`);
      throw new ProviderError(`${this.name} error: ${body.error.message}`, true);
    }
    const choice = body.choices?.[0];
    if (choice?.finish_reason === "length") {
      throw new ProviderError(
        `The reply for ${req.purpose} was cut off at ${maxTokens} tokens.`,
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

/** Whether LM Studio lists "off" among the model's thinking options, the only models reasoning_effort none suits. */
function canTurnThinkingOff(m: LmStudioModel): boolean {
  return Boolean(m.capabilities?.reasoning?.allowed_options?.includes("off"));
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
