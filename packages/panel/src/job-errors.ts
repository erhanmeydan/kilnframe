/** Checks whose reason the panel can say in the editor's language; the rest are covered by the sentence. */
const KNOWN = ["overlay_faint_layer", "scene_shows_nothing"] as const;
export type CheckKey = `check.${(typeof KNOWN)[number]}`;

/** The names editors know, for the provider ids the core puts in its messages. */
const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Claude",
  openai: "OpenAI",
  gemini: "Google Gemini",
  xai: "xAI",
  minimax: "MiniMax",
  zai: "Z.ai",
  openrouter: "OpenRouter",
  lmstudio: "LM Studio",
};

export type ReadableError =
  | { key: "job.checksFailed"; vars: { n: number }; reasons: CheckKey[] }
  | { key: "job.keyExpired" | "job.keyRejected"; vars: { provider: string }; reasons: [] };

/**
 * A job error the panel can say in its own language instead of the core's English: the composition that
 * failed its checks after the repair rounds, and an API key the provider turned down (an expired one said
 * as such). The English original goes to the log.
 */
export function readableJobError(message: string): ReadableError | null {
  const key = /^(\S+) rejected the API key\. Check it in the settings: ([\s\S]*)$/.exec(message);
  if (key) {
    const provider = PROVIDER_NAMES[key[1]!] ?? key[1]!;
    return {
      key: /expired/i.test(key[2]!) ? "job.keyExpired" : "job.keyRejected",
      vars: { provider },
      reasons: [],
    };
  }
  const m = /still fails validation after (\d+) repair rounds/.exec(message);
  if (!m) return null;
  const reasons = KNOWN.filter((code) => message.includes(`${code}:`)).map(
    (code) => `check.${code}` as CheckKey,
  );
  return { key: "job.checksFailed", vars: { n: Number(m[1]) }, reasons };
}
