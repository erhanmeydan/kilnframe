import {
  SpeechError,
  wavPcm,
  type SpeechProvider,
  type SpeechRequest,
  type SpeechResult,
} from "./types.js";

/** Where a local speech server is looked for when nothing else is set. */
export const LOCAL_SPEECH_URL = "http://127.0.0.1:8890";

/** The address of the editor's speech server: the caller's, then LOCAL_BASE_URL, then the catalog's. */
export function localSpeechBaseUrl(
  o: { baseUrl?: string | undefined; fallback?: string | undefined } = {},
): string {
  const url =
    o.baseUrl?.trim() || process.env.LOCAL_BASE_URL?.trim() || o.fallback || LOCAL_SPEECH_URL;
  return url.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** What the server says went wrong, from an OpenAI-style `{ error: { message } }` or a plain reply. */
async function failure(res: Response, what: string): Promise<SpeechError> {
  const json = (await res.json().catch(() => null)) as {
    error?: { message?: unknown } | string;
    detail?: unknown;
  } | null;
  const raw = typeof json?.error === "string" ? json.error : (json?.error?.message ?? json?.detail);
  const detail = (typeof raw === "string" && raw) || res.statusText;
  if (res.status === 401 || res.status === 403)
    return new SpeechError(`The speech server refused the token: ${detail}`);
  const wait = Number(res.headers.get("retry-after"));
  return new SpeechError(
    `The speech server's ${what} failed (${res.status}): ${detail}`,
    res.status === 429 || res.status >= 500,
    res.status === 429 ? (Number.isFinite(wait) && wait > 0 ? wait : 5) : undefined,
  );
}

async function send(doFetch: typeof fetch, url: string, init: RequestInit, base: string) {
  try {
    return await doFetch(url, init);
  } catch (err) {
    throw new SpeechError(
      `Could not reach the speech server at ${base}: ${err instanceof Error ? err.message : String(err)}`,
      true,
    );
  }
}

export interface OpenAICompatibleSpeechOptions {
  /** The server's address without /v1, e.g. http://127.0.0.1:8890. */
  baseUrl: string;
  model: string;
  /** An optional bearer token; a local server usually has none. */
  apiKey?: string | undefined;
  /** "wav" (default) or "pcm" (raw 24 kHz mono 16-bit little-endian, as OpenAI defines it). */
  responseFormat?: "wav" | "pcm";
  /** The rate of "pcm" replies; a "wav" reply says its own. */
  pcmSampleRate?: number;
  fetch?: typeof fetch;
}

/**
 * Any server that answers OpenAI's text to speech, POST {base}/v1/audio/speech
 * (platform.openai.com/docs/api-reference/audio/createSpeech): `{ model, input, voice, response_format }`
 * back comes the audio. No key is needed; a bearer token is sent when there is one.
 */
export class OpenAICompatibleSpeechProvider implements SpeechProvider {
  readonly id = "local";

  constructor(private readonly o: OpenAICompatibleSpeechOptions) {}

  get model(): string {
    return this.o.model;
  }

  body(req: SpeechRequest): unknown {
    const style = req.style?.replace(/\s+/g, " ").trim();
    return {
      model: this.o.model,
      input: req.text,
      voice: req.voice,
      response_format: this.o.responseFormat ?? "wav",
      ...(style ? { instructions: style } : {}),
    };
  }

  async synthesize(req: SpeechRequest): Promise<SpeechResult> {
    const doFetch = this.o.fetch ?? fetch;
    const base = this.o.baseUrl.replace(/\/+$/, "");
    const res = await send(
      doFetch,
      `${base}/v1/audio/speech`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.o.apiKey ? { Authorization: `Bearer ${this.o.apiKey}` } : {}),
        },
        body: JSON.stringify(this.body(req)),
      },
      base,
    );
    if (!res.ok) throw await failure(res, "speech");
    const audio = Buffer.from(await res.arrayBuffer());
    if (!audio.length) throw new SpeechError("The speech server returned no audio.");
    let pcm: Buffer;
    let sampleRate: number;
    if ((this.o.responseFormat ?? "wav") === "pcm") {
      pcm = audio;
      sampleRate = this.o.pcmSampleRate ?? 24000;
    } else {
      const wav = wavPcm(audio);
      if (wav.channels !== 1)
        throw new SpeechError("The speech server returned a WAV that is not mono.");
      pcm = wav.pcm;
      sampleRate = wav.sampleRate;
    }
    // an odd byte count would shift every sample after a join
    const even = pcm.length % 2 ? pcm.subarray(0, pcm.length - 1) : pcm;
    return {
      pcm: even,
      sampleRate,
      audioTokens: 0,
      inputTokens: 0,
      characters: req.text.length,
    };
  }
}

export interface LocalVoice {
  name: string;
  label: string;
  character: string;
}

/**
 * The voices a server offers, when it has a list: GET /v1/audio/voices answering `{ data: [{ id }] }` or
 * `{ voices: [{ id | name }] }`. Many servers have none; then the caller shows the catalog's voices.
 */
export async function listLocalVoices(o: {
  baseUrl: string;
  apiKey?: string | undefined;
  fetch?: typeof fetch;
}): Promise<LocalVoice[] | null> {
  const doFetch = o.fetch ?? fetch;
  const base = o.baseUrl.replace(/\/+$/, "");
  let res: Response;
  try {
    res = await doFetch(`${base}/v1/audio/voices`, {
      headers: o.apiKey ? { Authorization: `Bearer ${o.apiKey}` } : {},
    });
  } catch (err) {
    throw new SpeechError(
      `Could not reach the speech server at ${base}: ${err instanceof Error ? err.message : String(err)}`,
      true,
    );
  }
  if (res.status === 404 || res.status === 405 || res.status === 501) return null;
  if (!res.ok) throw await failure(res, "voice list");
  const json = (await res.json().catch(() => null)) as {
    data?: { id?: string; name?: string }[];
    voices?: { id?: string; name?: string }[];
  } | null;
  const out: LocalVoice[] = [];
  for (const v of json?.data ?? json?.voices ?? []) {
    const id = v.id ?? v.name;
    if (!id || out.some((x) => x.name === id)) continue;
    out.push({ name: id, label: v.name ?? id, character: "" });
  }
  return out;
}

/**
 * Makes a voice from a sample, if the server can: POST /v1/audio/voices as multipart with `name` and
 * `audio_sample` (the shape of OpenAI's custom voices). Answers the id to read with. A server without it
 * says 404/405/501, which becomes a plain message.
 */
export async function cloneLocalVoice(o: {
  baseUrl: string;
  apiKey?: string | undefined;
  name: string;
  /** A WAV of the speech. */
  audio: Buffer;
  fetch?: typeof fetch;
}): Promise<{ voiceId: string }> {
  const doFetch = o.fetch ?? fetch;
  const base = o.baseUrl.replace(/\/+$/, "");
  const form = new FormData();
  form.append("name", o.name);
  form.append(
    "audio_sample",
    new Blob([new Uint8Array(o.audio)], { type: "audio/wav" }),
    "sample.wav",
  );
  const res = await send(
    doFetch,
    `${base}/v1/audio/voices`,
    {
      method: "POST",
      headers: o.apiKey ? { Authorization: `Bearer ${o.apiKey}` } : {},
      body: form,
    },
    base,
  );
  if (res.status === 404 || res.status === 405 || res.status === 501)
    throw new SpeechError("This speech server cannot clone a voice (it has no /v1/audio/voices).");
  if (!res.ok) throw await failure(res, "voice cloning");
  const json = (await res.json().catch(() => null)) as {
    id?: string;
    voice?: string;
    name?: string;
  } | null;
  const voiceId = json?.id ?? json?.voice ?? json?.name;
  if (!voiceId) throw new SpeechError("The speech server did not return the new voice.");
  return { voiceId };
}
