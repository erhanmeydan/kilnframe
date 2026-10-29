import { t, type MessageKey } from "./i18n";

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
  | { key: "job.keyExpired" | "job.keyRejected"; vars: { provider: string }; reasons: [] }
  | { key: "job.contextTooSmall"; vars: Record<string, never>; reasons: [] }
  | { key: "job.geminiFreeTier"; vars: { limit: number; hours: number }; reasons: [] }
  | { key: "job.geminiFreeTierNoWait"; vars: { limit: number }; reasons: [] }
  | { key: "job.lyriaFreeTier"; vars: Record<string, never>; reasons: [] };

/**
 * A job error the panel can say in its own language instead of the core's English: the composition that
 * failed its checks after the repair rounds, an API key the provider turned down (an expired one said
 * as such), and a request too large for the context a local model is loaded with. The English original goes
 * to the log.
 */
export function readableJobError(message: string): ReadableError | null {
  // a free tier Gemini key gets no music at all (Lyria's limit there is 0)
  if (/Lyria failed \(429\)/.test(message) && /free[ _]tier|limit: 0\b/i.test(message))
    return { key: "job.lyriaFreeTier", vars: {}, reasons: [] };
  // a free tier key's daily request limit; Google says when it resets ("retry in 9h33m12s")
  const free = /free_tier_requests[\s\S]*?limit: (\d+)/.exec(message);
  if (free) {
    const limit = Number(free[1]);
    const wait = /retry in (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i.exec(message);
    if (wait && wait[0].length > "retry in ".length) {
      const hours = Number(wait[1] ?? 0) + Number(wait[2] ?? 0) / 60 + Number(wait[3] ?? 0) / 3600;
      return {
        key: "job.geminiFreeTier",
        vars: { limit, hours: Math.max(1, Math.ceil(hours)) },
        reasons: [],
      };
    }
    return { key: "job.geminiFreeTierNoWait", vars: { limit }, reasons: [] };
  }
  if (message.includes("The model's context in LM Studio is too small"))
    return { key: "job.contextTooSmall", vars: {}, reasons: [] };
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

/** A job error as the panel says it in its own language, or null when the panel has no words for it. */
export function readableJobText(message: string): string | null {
  const r = readableJobError(message);
  if (!r) return null;
  return [t(r.key as MessageKey, r.vars), ...r.reasons.map((k) => t(k as MessageKey))].join(" ");
}
