import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import {
  ProviderError,
  mentionsUnavailableModel,
  type Capabilities,
  type ModelInfo,
  type TextProvider,
  type TextRequest,
  type TextResponse,
} from "./types.js";

const NO_CREDENTIALS =
  "No Claude API key found. Set it in this terminal with export ANTHROPIC_API_KEY=... (or store it in the companion app), then run again.";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AnthropicOptions {
  model: string;
  effort: Effort;
  /** Omit to let the SDK resolve credentials (ANTHROPIC_API_KEY, `ant auth login` profile). */
  apiKey?: string | undefined;
  baseURL?: string | undefined;
  capabilities?: Partial<Capabilities>;
}

function toParams(messages: TextRequest["messages"]): Anthropic.Beta.BetaMessageParam[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content.map((p): Anthropic.Beta.BetaContentBlockParam =>
      p.type === "text"
        ? { type: "text", text: p.text }
        : { type: "image", source: { type: "base64", media_type: p.mediaType, data: p.base64 } },
    ),
  }));
}

/**
 * Claude via the official SDK. Streams (long compositions), uses adaptive thinking at the configured
 * effort, and enables server-side refusal fallbacks so a declined request is retried on a suitable
 * model inside the same call.
 */
export class AnthropicProvider implements TextProvider {
  readonly name = "anthropic";
  readonly billing = "api" as const;
  readonly model: string;
  readonly capabilities: Capabilities;
  private readonly client: Anthropic;
  private readonly effort: Effort;
  private readonly hasExplicitKey: boolean;

  constructor(o: AnthropicOptions) {
    this.model = o.model;
    this.effort = o.effort;
    this.hasExplicitKey = Boolean(o.apiKey);
    this.capabilities = {
      vision: true,
      structuredOutput: true,
      contextWindow: 1_000_000,
      ...o.capabilities,
    };
    this.client = new Anthropic({
      ...(o.apiKey ? { apiKey: o.apiKey } : {}),
      ...(o.baseURL ? { baseURL: o.baseURL } : {}),
    });
  }

  /**
   * The SDK resolves credentials from ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login`
   * profile. Without any of them every request would fail, so stop before the slow steps start.
   */
  preflight(): void {
    const env = process.env;
    const profileDir = join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "anthropic");
    if (
      this.hasExplicitKey ||
      env.ANTHROPIC_API_KEY ||
      env.ANTHROPIC_AUTH_TOKEN ||
      env.ANTHROPIC_PROFILE ||
      existsSync(profileDir)
    )
      return;
    throw new ProviderError(NO_CREDENTIALS, false);
  }

  async listModels(): Promise<ModelInfo[]> {
    const models: ModelInfo[] = [];
    for await (const m of this.client.models.list()) {
      models.push({
        id: m.id,
        displayName: m.display_name,
        contextWindow: m.max_input_tokens,
        vision: m.capabilities ? m.capabilities.image_input.supported : null,
      });
    }
    return models;
  }

  async complete(req: TextRequest): Promise<TextResponse> {
    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await this.client.beta.messages
        .stream({
          model: this.model,
          max_tokens: req.maxTokens,
          system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
          messages: toParams(req.messages),
          thinking: { type: "adaptive" },
          output_config: { effort: this.effort },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        })
        .finalMessage();
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) {
        throw new ProviderError(
          "The Anthropic API key was rejected. Check the key in the settings.",
          false,
        );
      }
      if (err instanceof Anthropic.RateLimitError) {
        throw new ProviderError("Anthropic rate limit reached. Wait a moment and try again.", true);
      }
      if (
        err instanceof Anthropic.NotFoundError ||
        (err instanceof Anthropic.BadRequestError && mentionsUnavailableModel(err.message))
      ) {
        throw new ProviderError(
          `Anthropic does not offer the model "${this.model}": ${err.message}`,
          false,
          "model-unavailable",
        );
      }
      if (err instanceof Anthropic.BadRequestError) {
        throw new ProviderError(`Anthropic rejected the request: ${err.message}`, false);
      }
      if (err instanceof Anthropic.APIError) {
        throw new ProviderError(
          `Anthropic API error${err.status ? ` ${err.status}` : ""}: ${err.message}`,
          true,
        );
      }
      if (
        err instanceof Error &&
        err.message.startsWith("Could not resolve authentication method")
      ) {
        throw new ProviderError(NO_CREDENTIALS, false);
      }
      if (err instanceof Anthropic.APIConnectionError) {
        throw new ProviderError(
          "Could not reach the Anthropic API. Check the internet connection.",
          true,
        );
      }
      throw err;
    }
    if (message.stop_reason === "refusal") {
      const category = message.stop_details?.category ?? "unspecified";
      throw new ProviderError(
        `The model declined this request (${category}). Try rewording the note or the content.`,
        false,
      );
    }
    if (message.stop_reason === "max_tokens") {
      throw new ProviderError(
        `The reply for ${req.purpose} was cut off at ${req.maxTokens} tokens.`,
        true,
        "cut-off",
      );
    }
    const text = message.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return {
      text,
      model: message.model,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      },
    };
  }
}
