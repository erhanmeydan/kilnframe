import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ffmpegPath, type Defaults } from "../config.js";
import { GeminiSpeechProvider } from "./gemini.js";
import { pcmWav, SpeechError, type SpeechProvider } from "./types.js";

export * from "./gemini.js";
export * from "./types.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

export interface SpeechCatalogProvider {
  id: string;
  displayName: string;
  endpoint: string;
  keyName: string;
  models: { id: string; label: string; price: { input: number; outputAudio: number } }[];
  audioTokensPerSecond: number;
  sampleRate: number;
  voices: { name: string; character: string }[];
}

export function loadSpeechCatalog(): SpeechCatalogProvider[] {
  return (
    JSON.parse(readFileSync(join(packageRoot, "config", "speech.json"), "utf8")) as {
      providers: SpeechCatalogProvider[];
    }
  ).providers;
}

/** The speech provider from the defaults or the caller's choice; the key comes from the keychain. */
export function createSpeechProvider(
  defaults: Defaults,
  o: {
    provider?: string | undefined;
    model?: string | undefined;
    apiKey?: string | undefined;
  } = {},
): SpeechProvider {
  const id = o.provider ?? defaults.speech.provider;
  const entry = loadSpeechCatalog().find((p) => p.id === id);
  if (!entry) throw new SpeechError(`Unknown speech provider "${id}".`);
  const apiKey = o.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey)
    throw new SpeechError(
      `No ${entry.displayName} key. Add one in the panel's settings (or set GEMINI_API_KEY for the CLI).`,
    );
  if (id === "gemini")
    return new GeminiSpeechProvider({
      apiKey,
      model: o.model ?? defaults.speech.model,
      endpoint: entry.endpoint,
      audioTokensPerSecond: entry.audioTokensPerSecond,
    });
  throw new SpeechError(`Speech provider "${id}" is not available yet.`);
}

/**
 * Splits narration into requests: paragraphs (blank lines), and paragraphs longer than `max` characters at
 * sentence ends, so no request grows too long and a failure only repeats one piece.
 */
export function speechChunks(text: string, max = 1200): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim())) {
    if (!para) continue;
    if (para.length <= max) {
      out.push(para);
      continue;
    }
    let current = "";
    for (const sentence of para.match(/[^.!?…]+[.!?…]+["'”’)]*\s*|[^.!?…]+$/g) ?? [para]) {
      if (current && current.length + sentence.length > max) {
        out.push(current.trim());
        current = "";
      }
      current += sentence;
    }
    if (current.trim()) out.push(current.trim());
  }
  return out;
}

export interface NarrationResult {
  /** 48 kHz mono 16-bit WAV, ready for Premiere. */
  file: string;
  durationS: number;
  audioTokens: number;
  inputTokens: number;
  /** Where each chunk starts in the narration, in seconds. */
  chunks: { text: string; startS: number; endS: number }[];
}

/**
 * Reads the text aloud piece by piece with one voice and style, joins the pieces with a short pause and
 * writes a 48 kHz WAV. Retries a piece twice on a retryable error.
 */
export async function narrate(o: {
  provider: SpeechProvider;
  text: string;
  voice: string;
  style?: string | undefined;
  outFile: string;
  pauseS?: number;
  onProgress?: (message: string) => void;
}): Promise<NarrationResult> {
  const pieces = speechChunks(o.text);
  if (!pieces.length) throw new SpeechError("There is no text to read.");
  const parts: Buffer[] = [];
  const chunks: NarrationResult["chunks"] = [];
  let rate = 0;
  let audioTokens = 0;
  let inputTokens = 0;
  let at = 0;
  for (const [i, text] of pieces.entries()) {
    o.onProgress?.(`Reading aloud ${i + 1}/${pieces.length}`);
    let result;
    for (let attempt = 1; ; attempt++) {
      try {
        result = await o.provider.synthesize({ text, voice: o.voice, style: o.style });
        break;
      } catch (err) {
        // a rate limit is waited out (a long story makes more requests a minute than Tier 1 allows)
        const limited = err instanceof SpeechError && err.retryAfterS !== undefined;
        if (!(err instanceof SpeechError) || !err.retryable || attempt >= (limited ? 6 : 3))
          throw err;
        const waitS = limited
          ? Math.min(90, Math.ceil(err.retryAfterS as number) + 1)
          : 1.5 * attempt;
        if (limited) o.onProgress?.(`Waiting for the speech service's rate limit (${waitS} s)`);
        await new Promise((r) => setTimeout(r, waitS * 1000));
      }
    }
    if (rate && result.sampleRate !== rate)
      throw new SpeechError("The speech pieces came back at different sample rates.");
    rate = result.sampleRate;
    if (i > 0) {
      const gap = Buffer.alloc(Math.round((o.pauseS ?? 0.45) * rate) * 2);
      parts.push(gap);
      at += gap.length / 2 / rate;
    }
    parts.push(result.pcm);
    const len = result.pcm.length / 2 / rate;
    chunks.push({ text, startS: +at.toFixed(3), endS: +(at + len).toFixed(3) });
    at += len;
    audioTokens += result.audioTokens;
    inputTokens += result.inputTokens;
  }
  mkdirSync(dirname(o.outFile), { recursive: true });
  const raw = `${o.outFile}.raw.wav`;
  writeFileSync(raw, pcmWav(Buffer.concat(parts), rate));
  const r = spawnSync(ffmpegPath(), [
    "-v",
    "error",
    "-y",
    "-i",
    raw,
    "-ar",
    "48000",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    o.outFile,
  ]);
  rmSync(raw, { force: true });
  if (r.status !== 0) throw new SpeechError(`Could not write ${o.outFile}: ${String(r.stderr)}`);
  return { file: o.outFile, durationS: +at.toFixed(3), audioTokens, inputTokens, chunks };
}
