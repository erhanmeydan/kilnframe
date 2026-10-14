import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Defaults } from "../config.js";
import { AnthropicProvider, type Effort } from "./anthropic.js";
import { ClaudeCodeProvider, claudeCodeStatus } from "./claude-code.js";
import { CodexProvider } from "./codex.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { ProviderError, type TextProvider } from "./types.js";

export * from "./anthropic.js";
export * from "./claude-code.js";
export * from "./codex.js";
export * from "./openai-compatible.js";
export * from "./types.js";

export interface ProviderOverrides {
  provider?: string | undefined;
  model?: string | undefined;
  effort?: string | undefined;
  baseURL?: string | undefined;
  /** Key from the OS keychain (companion); the CLI falls back to environment variables. */
  apiKey?: string | undefined;
  /** "suggest" may use a lighter model than the main work (defaults.text.suggestModel). */
  purpose?: "main" | "suggest" | undefined;
  /** Told when a side task falls back to the main model. */
  onFallback?: ((message: string) => void) | undefined;
}

const CLAUDE_PROVIDERS = new Set(["claude-code", "anthropic"]);
const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

/** One entry of config/providers.json: what the panel offers and how the pipeline connects. */
export interface ProviderPreset {
  id: string;
  displayName: string;
  adapter: "anthropic" | "openai-compatible";
  /** Null for the Anthropic API; a {Placeholder} in it must be filled in by the editor. */
  baseURL: string | null;
  models: string[];
  capabilities: {
    /** "per-model": a local server; only the models it reports as reading images are offered. */
    vision: boolean | "per-model";
    structuredOutput: boolean;
    contextWindow: number;
  };
  tier: "recommended" | "works" | "experimental";
  requires?: string[];
  regions?: Record<string, string>;
  /** Where the editor creates a key. */
  keyUrl?: string;
  /**
   * Models measured as slow in the model comparison (8 Oct 2026): the panel warns
   * before a job. "*" marks every model of the preset (a local model runs on the editor's computer).
   */
  slowModels?: string[];
  /**
   * OpenRouter's reasoning.effort per model, for models that think until they hit the output limit (GLM 5.3
   * Flash, 11 Oct 2026). Other models get nothing and think as they do by default.
   */
  reasoningEffort?: Record<string, string>;
  /** How the thinking level is sent: "reasoning" (OpenRouter, default) or "reasoning_effort" (Z.ai). */
  reasoningField?: "reasoning" | "reasoning_effort";
}

export function loadProviderCatalog(): ProviderPreset[] {
  return (
    JSON.parse(readFileSync(join(packageRoot, "config", "providers.json"), "utf8")) as {
      providers: ProviderPreset[];
    }
  ).providers;
}

export function providerPreset(id: string): ProviderPreset | undefined {
  return loadProviderCatalog().find((p) => p.id === id);
}

/** A local server (LM Studio) needs no key. */
export function presetNeedsKey(p: ProviderPreset): boolean {
  return !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(p.baseURL ?? "");
}

/** The first recommended model of the preset whose base URL matches, for example MiniMax-M3. */
export function presetModel(baseURL: string): string | undefined {
  const norm = (u: string) => u.replace(/\/+$/, "").toLowerCase();
  return loadProviderCatalog().find((p) => p.baseURL && norm(p.baseURL) === norm(baseURL))
    ?.models?.[0];
}

/**
 * Picks the models for a provider. The defaults name Claude models, so they only apply to Claude
 * providers; any other provider uses the model the user chose, else its preset's recommended model.
 * Returns the model for this purpose and the main model to fall back to.
 */
export function resolveModels(
  kind: string,
  defaults: Defaults,
  o: ProviderOverrides,
  baseURL?: string,
): { model: string; main: string } {
  if (CLAUDE_PROVIDERS.has(kind)) {
    const main = o.purpose === "suggest" ? defaults.text.model : (o.model ?? defaults.text.model);
    const model = o.purpose === "suggest" ? (o.model ?? defaults.text.suggestModel ?? main) : main;
    return { model, main };
  }
  const main =
    o.model ?? providerPreset(kind)?.models[0] ?? (baseURL ? presetModel(baseURL) : undefined);
  if (!main)
    throw new ProviderError(
      "No model chosen for this provider. Pick a model in the settings (or pass --model).",
      false,
    );
  return { model: main, main };
}

/**
 * Wraps a provider so that a side task whose model the provider does not offer falls back once to the
 * main model instead of failing the job (for example the suggestion model on an account without it).
 */
export function withModelFallback(
  primary: TextProvider,
  fallback: () => TextProvider,
  onFallback?: (message: string) => void,
): TextProvider {
  let active = primary;
  return {
    get name() {
      return active.name;
    },
    get model() {
      return active.model;
    },
    get capabilities() {
      return active.capabilities;
    },
    ...(primary.billing ? { billing: primary.billing } : {}),
    ...(primary.preflight ? { preflight: () => primary.preflight?.() } : {}),
    ...(primary.listModels ? { listModels: () => primary.listModels!() } : {}),
    // the model in use: the fallback's once the primary model turned out unavailable
    modelPrice: () => active.modelPrice?.() ?? Promise.resolve(undefined),
    async complete(req) {
      try {
        return await active.complete(req);
      } catch (err) {
        if (
          active !== primary ||
          !(err instanceof ProviderError) ||
          err.kind !== "model-unavailable"
        )
          throw err;
        active = fallback();
        onFallback?.(`${primary.model} is not available here; using ${active.model} instead.`);
        return active.complete(req);
      }
    },
  };
}

/**
 * Builds the text provider from config plus CLI overrides. Keys come from the environment for the CLI
 * (the companion app will read them from the OS keychain instead).
 */
export function createTextProvider(defaults: Defaults, o: ProviderOverrides = {}): TextProvider {
  const kind = resolveKind(defaults, o);
  // the user's ChatGPT plan through Codex; no model named means the one set in Codex itself
  if (kind === "codex")
    return new CodexProvider({ model: o.model ?? "", effort: o.effort ?? defaults.text.effort });
  const preset = kind === "anthropic" ? undefined : providerPreset(kind);
  const baseURL =
    kind === "openai-compatible" || kind === "custom"
      ? (o.baseURL ?? defaults.text.baseURL)
      : (o.baseURL ?? preset?.baseURL ?? undefined);
  if (baseURL?.includes("{"))
    throw new ProviderError(
      `${preset?.displayName ?? kind} needs your own address (it contains ${baseURL.match(/\{\w+\}/)?.[0]}). Enter it in the settings.`,
      false,
    );
  if ((kind === "openai-compatible" || kind === "custom") && !baseURL)
    throw new ProviderError(
      kind === "custom"
        ? "The custom endpoint needs its address (base URL). Enter it in the settings."
        : "openai-compatible needs --base-url (for example http://localhost:1234/v1 for LM Studio).",
      false,
    );
  const { model, main } = resolveModels(kind, defaults, o, baseURL);
  const build = (m: string) => buildProvider(kind, m, defaults, o, baseURL);
  const provider = build(model);
  return model === main ? provider : withModelFallback(provider, () => build(main), o.onFallback);
}

function resolveKind(defaults: Defaults, o: ProviderOverrides): string {
  const kind = o.provider ?? defaults.text.provider;
  if (kind !== "auto") return kind;
  // Like HyperFrames Studio: the user's Claude plan when Claude Code is signed in, else an API key.
  const s = claudeCodeStatus();
  return s.installed && s.loggedIn ? "claude-code" : "anthropic";
}

function buildProvider(
  kind: string,
  model: string,
  defaults: Defaults,
  o: ProviderOverrides,
  baseURL: string | undefined,
): TextProvider {
  const effort = o.effort ?? defaults.text.effort;
  if (kind === "claude-code") {
    return new ClaudeCodeProvider({ model, effort, usePlan: true });
  }
  if (kind === "anthropic") {
    return new AnthropicProvider({
      model,
      effort: effort as Effort,
      apiKey: o.apiKey ?? process.env.ANTHROPIC_API_KEY,
      baseURL,
    });
  }
  const preset = providerPreset(kind);
  if (kind === "custom" || (preset && preset.adapter === "openai-compatible")) {
    if (!baseURL) throw new ProviderError("This provider needs an address (base URL).", false);
    return new OpenAICompatibleProvider({
      name: kind,
      baseURL,
      model,
      // the companion passes the keychain key; the CLI falls back to the environment
      apiKey: o.apiKey ?? process.env.KILNFRAME_API_KEY,
      // only models that read images are offered; a custom endpoint is checked by the
      // connection test with a picture
      capabilities: {
        vision: true,
        structuredOutput: preset?.capabilities.structuredOutput ?? false,
        contextWindow: preset?.capabilities.contextWindow ?? 128_000,
      },
      reasoningEffort: preset?.reasoningEffort?.[model],
      reasoningField: preset?.reasoningField,
    });
  }
  if (kind === "openai-compatible") {
    if (!baseURL)
      throw new Error(
        "openai-compatible needs --base-url (for example http://localhost:1234/v1 for LM Studio).",
      );
    return new OpenAICompatibleProvider({
      name: "openai-compatible",
      baseURL,
      model,
      apiKey: o.apiKey ?? process.env.KILNFRAME_API_KEY,
      capabilities: { vision: false, structuredOutput: false, contextWindow: 128_000 },
    });
  }
  throw new Error(
    `Unknown provider "${kind}". Use auto, claude-code, a provider from providers.json, custom or openai-compatible.`,
  );
}
export * from "./test.js";
export * from "./grok.js";
export * from "./agent-updates.js";
