import {
  SpeechError,
  type SpeechProvider,
  type SpeechRequest,
  type SpeechResult,
} from "./types.js";

/**
 * ElevenLabs text to speech (elevenlabs.io/docs/api-reference/text-to-speech/convert, checked
 * 2026-11-06): POST /v1/text-to-speech/{voice_id}?output_format=pcm_24000 returns raw 24 kHz mono
 * 16-bit little-endian PCM. Voices are ids from the editor's own account, so their clones work too.
 */
export class ElevenLabsSpeechProvider implements SpeechProvider {
  readonly id = "elevenlabs";

  constructor(
    private readonly o: {
      apiKey: string;
      model: string;
      endpoint: string;
      sampleRate?: number;
      fetch?: typeof fetch;
    },
  ) {}

  get model(): string {
    return this.o.model;
  }

  /** v3 and v4 take a delivery direction as an audio tag; older models would read the tag aloud. */
  takesTags(): boolean {
    return /^eleven_v[3-9]/.test(this.o.model);
  }

  text(req: SpeechRequest): string {
    const style = req.style?.replace(/[[\]]/g, "").replace(/\s+/g, " ").trim();
    return style && this.takesTags() ? `[${style}] ${req.text}` : req.text;
  }

  body(req: SpeechRequest): unknown {
    return {
      text: this.text(req),
      model_id: this.o.model,
      ...(req.language ? { language_code: req.language.slice(0, 2).toLowerCase() } : {}),
      ...(req.previousText ? { previous_text: req.previousText } : {}),
      ...(req.nextText ? { next_text: req.nextText } : {}),
    };
  }

  async synthesize(req: SpeechRequest): Promise<SpeechResult> {
    const doFetch = this.o.fetch ?? fetch;
    const rate = this.o.sampleRate ?? 24000;
    const url = `${this.o.endpoint.replace(/\/$/, "")}/v1/text-to-speech/${encodeURIComponent(req.voice)}?output_format=pcm_${rate}`;
    const body = this.body(req);
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { "xi-api-key": this.o.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new SpeechError(
        `Could not reach ElevenLabs: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }
    if (!res.ok) throw await elevenLabsError(res);
    const pcm = Buffer.from(await res.arrayBuffer());
    if (!pcm.length) throw new SpeechError("ElevenLabs returned no audio.");
    // an odd byte count would shift every sample after a join
    const even = pcm.length % 2 ? pcm.subarray(0, pcm.length - 1) : pcm;
    return {
      pcm: even,
      sampleRate: rate,
      audioTokens: 0,
      inputTokens: 0,
      characters: (body as { text: string }).text.length,
    };
  }
}

/** A readable error from an ElevenLabs reply: its `detail` is an object, a list or a string. */
async function elevenLabsError(res: Response): Promise<SpeechError> {
  const json = (await res.json().catch(() => null)) as { detail?: unknown } | null;
  const d = json?.detail;
  const status =
    d && typeof d === "object" && !Array.isArray(d)
      ? String((d as Record<string, unknown>).status ?? "")
      : "";
  const detail =
    (d && typeof d === "object" && !Array.isArray(d)
      ? String((d as Record<string, unknown>).message ?? "")
      : Array.isArray(d)
        ? d.map((x) => String((x as Record<string, unknown>).msg ?? "")).join("; ")
        : typeof d === "string"
          ? d
          : "") || res.statusText;
  // a used-up quota comes back as 401 too, so the status is read first
  if (res.status === 402 || /quota_exceeded|payment_required/.test(status))
    return new SpeechError(`Your ElevenLabs account is out of credits: ${detail}`);
  // a key made with restricted permissions: say which switch to turn on in the key's settings
  if (/missing_permissions/.test(status))
    return new SpeechError(
      `The ElevenLabs key is missing a permission. On elevenlabs.io under API keys, edit the key and allow Text to Speech and Voices (read). ${detail}`,
    );
  if (res.status === 401 || /invalid_api_key/.test(status))
    return new SpeechError(`The ElevenLabs key was refused: ${detail}`);
  if (res.status === 404 || /voice_not_found/.test(status))
    return new SpeechError(`ElevenLabs could not find this voice: ${detail}`);
  const wait = Number(res.headers.get("retry-after"));
  return new SpeechError(
    `ElevenLabs speech failed (${res.status}): ${detail}`,
    res.status === 429 || res.status >= 500,
    res.status === 429 ? (Number.isFinite(wait) && wait > 0 ? wait : 5) : undefined,
  );
}

export interface ElevenLabsVoice {
  /** The voice id the API reads with. */
  name: string;
  /** What the editor sees. */
  label: string;
  character: string;
  /** A voice the editor cloned, designed or saved to their own library. */
  own: boolean;
}

/**
 * The voices of the editor's account (elevenlabs.io/docs/api-reference/voices/search, checked
 * 2026-11-06): their own and saved voices first, then the default ones.
 */
export async function listElevenLabsVoices(o: {
  apiKey: string;
  endpoint: string;
  fetch?: typeof fetch;
}): Promise<ElevenLabsVoice[]> {
  const doFetch = o.fetch ?? fetch;
  const base = `${o.endpoint.replace(/\/$/, "")}/v2/voices?page_size=100&include_total_count=false&sort=name&sort_direction=asc`;
  const out: ElevenLabsVoice[] = [];
  for (const type of ["non-default", "default"] as const) {
    let res: Response;
    try {
      res = await doFetch(`${base}&voice_type=${type}`, {
        headers: { "xi-api-key": o.apiKey },
      });
    } catch (err) {
      throw new SpeechError(
        `Could not reach ElevenLabs: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }
    if (!res.ok) throw await elevenLabsError(res);
    const json = (await res.json()) as {
      voices?: {
        voice_id?: string;
        name?: string;
        category?: string;
        labels?: Record<string, string> | null;
      }[];
    };
    for (const v of json.voices ?? []) {
      if (!v.voice_id || out.some((x) => x.name === v.voice_id)) continue;
      const labels = v.labels ?? {};
      const character =
        v.category === "cloned" || v.category === "professional"
          ? "cloned"
          : v.category === "generated"
            ? "generated"
            : [labels.descriptive ?? labels.description, labels.gender, labels.accent]
                .filter(Boolean)
                .join(", ");
      out.push({
        name: v.voice_id,
        label: (v.name ?? v.voice_id).split(" - ")[0]?.trim() || v.voice_id,
        character,
        own: type === "non-default",
      });
    }
  }
  return out;
}
