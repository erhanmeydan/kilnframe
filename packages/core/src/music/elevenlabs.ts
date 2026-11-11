import { elevenLabsFailure } from "../speech/elevenlabs.js";
import { MusicError } from "./errors.js";

/** ElevenLabs takes 3 s to 5 min in one piece. */
const MIN_MS = 3_000;
const MAX_MS = 300_000;

/**
 * One instrumental piece from ElevenLabs Music, exactly as long as asked (unlike Lyria, which is told a length
 * in words). The answer is MP3 at 48 kHz.
 */
export async function composeElevenLabsMusic(o: {
  apiKey: string;
  model: string;
  endpoint: string;
  prompt: string;
  durationS: number;
  fetch?: typeof fetch;
}): Promise<{ audio: Buffer; mimeType: string }> {
  const doFetch = o.fetch ?? fetch;
  const ms = Math.min(MAX_MS, Math.max(MIN_MS, Math.round(o.durationS * 1000)));
  let res: Response;
  try {
    res = await doFetch(`${o.endpoint}?output_format=mp3_48000_192`, {
      method: "POST",
      headers: { "xi-api-key": o.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: o.prompt,
        model_id: o.model,
        music_length_ms: ms,
        force_instrumental: true,
      }),
    });
  } catch (err) {
    throw new MusicError(
      `Could not reach ElevenLabs: ${err instanceof Error ? err.message : String(err)}`,
      true,
    );
  }
  if (!res.ok) {
    const f = await elevenLabsFailure(res, "music");
    throw new MusicError(f.message, f.retryable, f.retryAfterS);
  }
  const audio = Buffer.from(await res.arrayBuffer());
  if (!audio.length) throw new MusicError("ElevenLabs returned no music.");
  return { audio, mimeType: "audio/mpeg" };
}
