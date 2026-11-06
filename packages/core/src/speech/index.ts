import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ffmpegPath, type Defaults } from "../config.js";
import { ElevenLabsSpeechProvider } from "./elevenlabs.js";
import { GeminiSpeechProvider } from "./gemini.js";
import { pcmWav, SpeechError, type SpeechProvider } from "./types.js";

export * from "./elevenlabs.js";
export * from "./gemini.js";
export * from "./types.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

export interface SpeechCatalogProvider {
  id: string;
  displayName: string;
  endpoint: string;
  keyName: string;
  /** Where the editor makes a key. */
  keyUrl?: string;
  /** Gemini prices by the million tokens, ElevenLabs by the thousand characters. */
  models: {
    id: string;
    label: string;
    price: { input?: number; outputAudio?: number; perThousandChars?: number };
  }[];
  audioTokensPerSecond?: number;
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

/** The model a provider reads with: the defaults' when they name this provider, else its first. */
export function speechModelFor(defaults: Defaults, provider: string): string | undefined {
  if (provider === defaults.speech.provider) return defaults.speech.model;
  return loadSpeechCatalog().find((p) => p.id === provider)?.models[0]?.id;
}

/** What a narration costs at the provider's list price, in USD; 0 when the model has no price. */
export function speechPriceUsd(
  provider: string,
  model: string,
  used: { audioTokens: number; inputTokens: number; characters?: number },
): number {
  const price = loadSpeechCatalog()
    .find((p) => p.id === provider)
    ?.models.find((m) => m.id === model)?.price;
  if (!price) return 0;
  if (price.perThousandChars !== undefined)
    return ((used.characters ?? 0) * price.perThousandChars) / 1000;
  return (
    (used.audioTokens * (price.outputAudio ?? 0) + used.inputTokens * (price.input ?? 0)) / 1e6
  );
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
  const envName = `${id.toUpperCase()}_API_KEY`;
  const apiKey = o.apiKey ?? process.env[envName];
  if (!apiKey)
    throw new SpeechError(
      `No ${entry.displayName} key. Add one in the panel's settings (or set ${envName} for the CLI).`,
    );
  const model = o.model ?? speechModelFor(defaults, id) ?? defaults.speech.model;
  if (id === "gemini")
    return new GeminiSpeechProvider({
      apiKey,
      model,
      endpoint: entry.endpoint,
      audioTokensPerSecond: entry.audioTokensPerSecond ?? 25,
    });
  if (id === "elevenlabs")
    return new ElevenLabsSpeechProvider({
      apiKey,
      model,
      endpoint: entry.endpoint,
      sampleRate: entry.sampleRate,
    });
  throw new SpeechError(`Speech provider "${id}" is not available yet.`);
}

/** The longest sample a clone is made from: ElevenLabs says more than about 3 minutes adds nothing. */
export const VOICE_SAMPLE_MAX_S = 180;

/**
 * Cuts a voice sample for cloning out of an exported range: mono 44.1 kHz, at most three minutes,
 * levelled to about -20 LUFS with peaks under -3 dB (ElevenLabs asks for -23 to -18 dB RMS).
 */
export function cutVoiceSample(o: {
  input: string;
  startS: number;
  endS: number;
  outFile: string;
}): { file: string; durationS: number } {
  const durationS = Math.min(VOICE_SAMPLE_MAX_S, Math.max(0, o.endS - o.startS));
  if (durationS < 1) throw new SpeechError("The range is too short to clone a voice from.");
  mkdirSync(dirname(o.outFile), { recursive: true });
  const r = spawnSync(ffmpegPath(), [
    "-v",
    "error",
    "-y",
    "-ss",
    String(Math.max(0, o.startS)),
    "-t",
    String(durationS),
    "-i",
    o.input,
    "-af",
    "loudnorm=I=-20:TP=-3:LRA=11",
    "-ar",
    "44100",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    o.outFile,
  ]);
  if (r.status !== 0)
    throw new SpeechError(`Could not cut the voice sample: ${String(r.stderr).trim()}`);
  return { file: o.outFile, durationS };
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
  /** Characters billed, for providers that charge by the character. */
  characters: number;
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
  /** ISO 639-1 code of the text, for providers that take it. */
  language?: string | undefined;
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
  let characters = 0;
  let at = 0;
  for (const [i, text] of pieces.entries()) {
    o.onProgress?.(`Reading aloud ${i + 1}/${pieces.length}`);
    let result;
    for (let attempt = 1; ; attempt++) {
      try {
        result = await o.provider.synthesize({
          text,
          voice: o.voice,
          style: o.style,
          language: o.language,
          previousText: pieces[i - 1],
          nextText: pieces[i + 1],
        });
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
    characters += result.characters ?? 0;
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
  return {
    file: o.outFile,
    durationS: +at.toFixed(3),
    audioTokens,
    inputTokens,
    characters,
    chunks,
  };
}
