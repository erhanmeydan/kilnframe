export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: "image/png" | "image/jpeg"; base64: string };

export interface ChatMessage {
  role: "user" | "assistant";
  content: ContentPart[];
}

export interface TextRequest {
  system: string;
  messages: ChatMessage[];
  /** Upper bound for the reply; adapters stream so large values are safe. */
  maxTokens: number;
  /** Short label for logs and usage accounting, e.g. "plan" or "compose s2". */
  purpose: string;
}

export interface Usage {
  /** Uncached input tokens. */
  inputTokens: number;
  outputTokens: number;
  /** Prompt-cache writes and reads, billed differently from plain input. */
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  /** What the call would cost at API list prices, when the provider reports it (Claude Code does). */
  listPriceUsd?: number;
}

export interface TextResponse {
  text: string;
  usage: Usage;
  /** The model that actually answered (may differ when a fallback served the request). */
  model: string;
}

/** Capability flags. The pipeline adapts to them. */
export interface Capabilities {
  vision: boolean;
  structuredOutput: boolean;
  contextWindow: number;
}

/** A model the signed-in account or key can use, as reported by the provider. */
export interface ModelInfo {
  id: string;
  displayName: string;
  contextWindow: number | null;
  vision: boolean | null;
}

export interface TextProvider {
  readonly name: string;
  readonly model: string;
  readonly capabilities: Capabilities;
  /** Who pays: the user's subscription plan or API credits. */
  readonly billing?: "plan" | "api";
  complete(request: TextRequest): Promise<TextResponse>;
  /** Fails fast, before transcription, when the provider cannot work (for example no credentials). */
  preflight?(): void;
  /** Models available to this account, for the model picker. */
  listModels?(): Promise<ModelInfo[]>;
}

/** A provider failure with a message a user can act on. Never contains the API key. */
export type ProviderErrorKind = "model-unavailable" | "cut-off";

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    /**
     * "model-unavailable": the provider does not offer the requested model; another model may work.
     * "cut-off": the reply hit the output limit before it ended, often a model that thinks at great length.
     */
    readonly kind?: ProviderErrorKind,
  ) {
    super(message);
  }
}

/** True when a provider's error text says the requested model does not exist or is not available. */
export function mentionsUnavailableModel(detail: string): boolean {
  return /model[_ ]not[_ ]found|\bmodel\b.{0,60}(not[ _]found|not exist|doesn't exist|unknown|invalid|not available|unsupported|no access|not supported|not have access)|(not[ _]found|does not exist|unknown|invalid|unsupported|no such)\b.{0,40}\bmodel\b/i.test(
    detail,
  );
}

/** Collects token usage across calls so the panel can show cost. */
export class UsageMeter {
  readonly calls: { purpose: string; model: string; usage: Usage }[] = [];

  wrap(provider: TextProvider): TextProvider {
    return {
      name: provider.name,
      model: provider.model,
      capabilities: provider.capabilities,
      ...(provider.billing ? { billing: provider.billing } : {}),
      ...(provider.preflight ? { preflight: () => provider.preflight?.() } : {}),
      ...(provider.listModels ? { listModels: () => provider.listModels!() } : {}),
      complete: async (req) => {
        const res = await provider.complete(req);
        this.calls.push({ purpose: req.purpose, model: res.model, usage: res.usage });
        return res;
      },
    };
  }

  total(): Usage {
    return this.calls.reduce(
      (t, c) => ({
        inputTokens: t.inputTokens + c.usage.inputTokens,
        outputTokens: t.outputTokens + c.usage.outputTokens,
        cacheWriteTokens: (t.cacheWriteTokens ?? 0) + (c.usage.cacheWriteTokens ?? 0),
        cacheReadTokens: (t.cacheReadTokens ?? 0) + (c.usage.cacheReadTokens ?? 0),
        listPriceUsd: (t.listPriceUsd ?? 0) + (c.usage.listPriceUsd ?? 0),
      }),
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        listPriceUsd: 0,
      } as Usage,
    );
  }
}
