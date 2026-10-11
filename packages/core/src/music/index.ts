import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ffmpegPath, type Defaults } from "../config.js";
import { transcribe } from "../stages/transcribe.js";

/**
 * A music bed under the narration: Lyria writes an instrumental piece from the style's
 * music brief and the story's subject; ffmpeg fits it to the narration and ducks it under the voice. The bed
 * goes on its own audio track so the editor can change or drop it.
 */

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

export class MusicError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export interface MusicCatalogProvider {
  id: string;
  displayName: string;
  endpoint: string;
  keyName: string;
  models: { id: string; label: string; maxS: number; pricePerSong: number }[];
}

export function loadMusicCatalog(): MusicCatalogProvider[] {
  return (
    JSON.parse(readFileSync(join(packageRoot, "config", "music.json"), "utf8")) as {
      providers: MusicCatalogProvider[];
    }
  ).providers;
}

/** The text Lyria gets: always instrumental, a bed that stays out of the voice's way, about the right length. */
export function musicPrompt(o: {
  brief: string;
  subject?: string | undefined;
  durationS: number;
}): string {
  const s = Math.round(o.durationS);
  const length = s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
  return [
    `Instrumental only, no vocals, no singing, no spoken words. A background score of about ${length} under a documentary narration.`,
    o.brief.trim(),
    o.subject?.trim() ? `The narration is about: ${o.subject.trim()}.` : "",
    "Keep the mid range (300 Hz to 3 kHz) open for the voice: no busy lead melody, no sudden drops or builds, a steady pulse, a gentle start and a clear ending.",
  ]
    .filter(Boolean)
    .join(" ");
}

/** One Lyria request through the Interactions API; returns the encoded audio as it came. */
export async function generateMusic(o: {
  apiKey: string;
  model: string;
  endpoint: string;
  prompt: string;
  fetch?: typeof fetch;
}): Promise<{ audio: Buffer; mimeType: string }> {
  const doFetch = o.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(o.endpoint, {
      method: "POST",
      headers: { "x-goog-api-key": o.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: o.model,
        input: o.prompt,
        response_format: { type: "audio", mime_type: "audio/wav" },
        stream: false,
      }),
    });
  } catch (err) {
    throw new MusicError(
      `Could not reach Lyria: ${err instanceof Error ? err.message : String(err)}`,
      true,
    );
  }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const detail =
      ((json?.error as Record<string, unknown> | undefined)?.message as string | undefined) ??
      res.statusText;
    if (res.status === 401 || res.status === 403 || /api key/i.test(detail))
      throw new MusicError(`The Gemini key was refused: ${detail}`);
    throw new MusicError(
      `Lyria failed (${res.status}): ${detail}`,
      res.status === 429 || res.status >= 500,
    );
  }
  const steps =
    (json?.steps as {
      type?: string;
      content?: { type?: string; data?: string; mime_type?: string }[];
    }[]) ?? [];
  const audio = steps
    .flatMap((s) => s.content ?? [])
    .filter((c) => c.type === "audio" && c.data)
    .at(-1);
  if (!audio?.data) throw new MusicError("Lyria returned no audio.");
  return { audio: Buffer.from(audio.data, "base64"), mimeType: audio.mime_type ?? "audio/wav" };
}

function ffmpeg(args: string[], what: string) {
  const r = spawnSync(ffmpegPath(), ["-v", "error", "-y", ...args]);
  if (r.status !== 0) throw new MusicError(`Could not ${what}: ${String(r.stderr).trim()}`);
}

function durationOf(file: string): number {
  const r = spawnSync(ffmpegPath(), ["-i", file, "-f", "null", "-"], { encoding: "utf8" });
  const m = /time=(\d+):(\d+):([\d.]+)(?![\s\S]*time=)/.exec(r.stderr);
  return m ? +m[1]! * 3600 + +m[2]! * 60 + +m[3]! : 0;
}

/**
 * Fits the raw piece to the narration: loops it with a crossfade when it is short, cuts it a little after the
 * voice ends with a fade out, and sets its level. Then ducks it under the narration (sidechain compression,
 * so it dips while someone speaks and comes back in the pauses). Writes 48 kHz stereo WAVs.
 */
export function fitMusic(o: {
  raw: string;
  narration: string;
  durationS: number;
  outFile: string;
  /** Integrated loudness of the bed before ducking. */
  lufs?: number;
  /** Extra seconds after the narration ends. */
  tailS?: number;
}): { file: string; bed: string; durationS: number } {
  const total = o.durationS + (o.tailS ?? 2.5);
  const fade = Math.min(3, total / 4);
  const dir = dirname(o.outFile);
  mkdirSync(dir, { recursive: true });
  const looped = join(dir, "music_looped.wav");
  const rawLen = durationOf(o.raw);
  if (rawLen <= 0) throw new MusicError("The music file is empty.");
  if (rawLen < total) {
    // repeat with a 3 s crossfade until it is long enough
    const times = Math.ceil((total - rawLen) / Math.max(1, rawLen - 3)) + 1;
    const inputs = Array.from({ length: times }, () => ["-i", o.raw]).flat();
    let chain = "";
    let last = "[0:a]";
    for (let i = 1; i < times; i++) {
      chain += `${last}[${i}:a]acrossfade=d=3:c1=tri:c2=tri[x${i}];`;
      last = `[x${i}]`;
    }
    ffmpeg(
      [...inputs, "-filter_complex", chain.slice(0, -1), "-map", last, looped],
      "loop the music",
    );
  } else {
    ffmpeg(["-i", o.raw, looped], "read the music");
  }
  const bed = join(dir, "music_bed.wav");
  ffmpeg(
    [
      "-i",
      looped,
      "-af",
      [
        `atrim=0:${total.toFixed(3)}`,
        "afade=t=in:d=0.6",
        `afade=t=out:st=${(total - fade).toFixed(3)}:d=${fade.toFixed(3)}`,
        `loudnorm=I=${o.lufs ?? -24}:TP=-2:LRA=9`,
        "aresample=48000",
      ].join(","),
      "-ac",
      "2",
      "-c:a",
      "pcm_s16le",
      bed,
    ],
    "shape the music",
  );
  rmSync(looped, { force: true });
  ffmpeg(
    [
      "-i",
      bed,
      "-i",
      o.narration,
      "-filter_complex",
      "[1:a]aformat=channel_layouts=stereo,aresample=48000,apad[sc];" +
        "[0:a][sc]sidechaincompress=threshold=0.03:ratio=6:attack=60:release=700:makeup=1[d]",
      "-map",
      "[d]",
      "-ac",
      "2",
      "-ar",
      "48000",
      "-c:a",
      "pcm_s16le",
      o.outFile,
    ],
    "duck the music under the voice",
  );
  return { file: o.outFile, bed, durationS: +total.toFixed(3) };
}

/** Writes the raw Lyria answer to disk with the right extension, so ffmpeg reads it whatever it is. */
export function saveRawMusic(audio: Buffer, mimeType: string, dir: string): string {
  mkdirSync(dir, { recursive: true });
  const ext = /mpeg|mp3/.test(mimeType) ? "mp3" : /wav/.test(mimeType) ? "wav" : "bin";
  const file = join(dir, `music_raw.${ext}`);
  writeFileSync(file, audio);
  return file;
}

/** The whole step: prompt, generate (two retries), fit and duck. */
/** A sung or spoken line has at least this many words in a row. */
const VOICE_WORDS = 6;

/**
 * Words that follow each other at the pace of a voice (0.15 to 1.5 s apart). Whisper also "hears" words in
 * plain instrumental music, but those are stray stock phrases ("Thank you.", "I'm going to go to the next
 * video.") with several words stamped at the same instant or seconds apart; a sung line is a steady run.
 */
export function sungWords(words: { start: number }[]): number {
  let n = 0;
  for (let i = 1; i < words.length; i++) {
    const gap = (words[i] as { start: number }).start - (words[i - 1] as { start: number }).start;
    if (gap >= 0.15 && gap <= 1.5) n++;
  }
  return n;
}

/** The brief used when Lyria refuses the story's own words. */
const PLAIN_BRIEF =
  "A calm, warm instrumental score for a spoken story: soft piano, light strings, a gentle pulse, no vocals.";

export async function makeMusic(o: {
  defaults: Defaults;
  apiKey: string;
  brief: string;
  subject?: string | undefined;
  narration: string;
  durationS: number;
  outFile: string;
  model?: string | undefined;
  fetch?: typeof fetch;
  onProgress?: ((message: string) => void) | undefined;
  /** How many words speech recognition hears in a file; the default runs the local Whisper model. */
  heardWords?: (file: string) => Promise<number>;
}): Promise<{ file: string; bed: string; durationS: number; priceUsd: number; prompt: string }> {
  if (!o.apiKey)
    throw new MusicError("No Gemini key for the music. Add one in the panel's settings.");
  const entry = loadMusicCatalog().find((p) => p.id === o.defaults.music.provider);
  if (!entry) throw new MusicError(`Unknown music provider "${o.defaults.music.provider}".`);
  const modelId = o.model ?? o.defaults.music.model;
  const model = entry.models.find((m) => m.id === modelId);
  if (!model) throw new MusicError(`Unknown music model "${modelId}".`);
  const prompt = musicPrompt({
    brief: o.brief,
    subject: o.subject,
    durationS: Math.min(o.durationS + 3, model.maxS),
  });
  o.onProgress?.("Writing the music");
  const heard =
    o.heardWords ??
    (async (file: string) =>
      sungWords(
        (await transcribe({ audioPath: file, defaults: o.defaults, language: "en" })).words,
      ));
  let asked = prompt;
  let raw: string;
  let songs = 0;
  // Lyria sometimes sings or whispers words although the prompt says instrumental (9 Oct 2026: "This
  // feeling... friends" under a promo's narration); a piece where Whisper hears words is written again
  for (let take = 1; ; take++) {
    let result;
    for (let attempt = 1; ; attempt++) {
      try {
        result = await generateMusic({
          apiKey: o.apiKey,
          model: model.id,
          endpoint: entry.endpoint,
          prompt: asked,
          ...(o.fetch ? { fetch: o.fetch } : {}),
        });
        break;
      } catch (err) {
        // Lyria's filter can refuse words of the editor's own (9 Oct 2026: a Turkish reading-style line);
        // the music does not need them, so it is asked once more with a plain brief and no subject
        if (
          err instanceof MusicError &&
          /blocked|sensitive|prohibited/i.test(err.message) &&
          asked === prompt
        ) {
          asked = musicPrompt({
            brief: PLAIN_BRIEF,
            durationS: Math.min(o.durationS + 3, model.maxS),
          });
          o.onProgress?.("Writing the music with a plainer brief");
          continue;
        }
        if (!(err instanceof MusicError) || !err.retryable || attempt >= 3) throw err;
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    songs++;
    raw = saveRawMusic(result.audio, result.mimeType, dirname(o.outFile));
    const words = await heard(raw).catch(() => 0);
    if (words < VOICE_WORDS || take >= 3) break;
    o.onProgress?.("The music had a voice in it; writing it again");
  }
  o.onProgress?.("Mixing the music under the voice");
  const fitted = fitMusic({
    raw,
    narration: o.narration,
    durationS: o.durationS,
    outFile: o.outFile,
    lufs: o.defaults.music.lufs,
  });
  return { ...fitted, priceUsd: model.pricePerSong * songs, prompt: asked };
}
