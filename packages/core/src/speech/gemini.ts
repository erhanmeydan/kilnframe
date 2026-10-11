import {
  SpeechError,
  wavPcm,
  type SpeechProvider,
  type SpeechRequest,
  type SpeechResult,
} from "./types.js";

/**
 * Gemini TTS through the Interactions API (ai.google.dev/gemini-api/docs/speech-generation, checked
 * 2026-10-07): a unary request returns a 24 kHz mono 16-bit WAV in steps[].content[] as base64.
 */
export class GeminiSpeechProvider implements SpeechProvider {
  readonly id = "gemini";

  constructor(
    private readonly o: {
      apiKey: string;
      model: string;
      endpoint: string;
      audioTokensPerSecond: number;
      fetch?: typeof fetch;
    },
  ) {}

  get model(): string {
    return this.o.model;
  }

  body(req: SpeechRequest): unknown {
    return {
      model: this.o.model,
      input: [
        {
          type: "user_input",
          content: [
            {
              type: "text",
              text: req.text,
              ...(req.style?.trim()
                ? { annotations: [{ type: "speech_metadata", style: req.style.trim() }] }
                : {}),
            },
          ],
        },
      ],
      response_format: { type: "audio", mime_type: "audio/wav", sample_rate: 24000 },
      generation_config: { speech_config: [{ voice: req.voice }] },
      stream: false,
    };
  }

  async synthesize(req: SpeechRequest): Promise<SpeechResult> {
    const doFetch = this.o.fetch ?? fetch;
    let res: Response;
    try {
      res = await doFetch(this.o.endpoint, {
        method: "POST",
        headers: { "x-goog-api-key": this.o.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(this.body(req)),
      });
    } catch (err) {
      throw new SpeechError(
        `Could not reach Gemini: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const detail =
        ((json?.error as Record<string, unknown> | undefined)?.message as string | undefined) ??
        res.statusText;
      if (res.status === 401 || res.status === 403 || /api key/i.test(detail))
        throw new SpeechError(`The Gemini key was refused: ${detail}`);
      // a rate limit says how long to wait: "Please retry in 44s" (Tier 1 allows 10 requests a minute)
      const wait = Number(
        /retry in ([\d.]+)\s*s/i.exec(detail)?.[1] ?? res.headers.get("retry-after"),
      );
      throw new SpeechError(
        `Gemini speech failed (${res.status}): ${detail}`,
        res.status === 429 || res.status >= 500,
        Number.isFinite(wait) && wait > 0 ? wait : undefined,
      );
    }
    const steps =
      (json?.steps as { type?: string; content?: { type?: string; data?: string }[] }[]) ?? [];
    const audio = steps
      .filter((s) => s.type === "model_output" || !s.type)
      .flatMap((s) => s.content ?? [])
      .filter((c) => c.type === "audio" && c.data)
      .at(-1);
    if (!audio?.data) throw new SpeechError("Gemini returned no audio.");
    const { pcm, sampleRate, channels } = wavPcm(Buffer.from(audio.data, "base64"));
    if (channels !== 1)
      throw new SpeechError(`Gemini returned ${channels} channels; mono expected.`);
    const usage = json?.usage as Record<string, number> | undefined;
    const seconds = pcm.length / 2 / sampleRate;
    return {
      pcm,
      sampleRate,
      audioTokens: usage?.output_tokens ?? Math.round(seconds * this.o.audioTokensPerSecond),
      inputTokens: usage?.input_tokens ?? 0,
    };
  }
}
