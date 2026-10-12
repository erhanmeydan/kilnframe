// The music-make step: one Lyria piece per section, fitted to its section, joined (a crossfade is baked into
// the next clip's head), ducked under the speech by the level curve; the last piece's own close ends the range.
// Raw pieces are kept per section, so making one section again re-cuts its neighbours without Lyria.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ffmpegPath } from "../../config.js";
import type { Word } from "../../schemas/transcript.js";
import { generateMusic, loadMusicCatalog, MusicError, saveRawMusic } from "../index.js";
import { readAudio, SR, writeAudio } from "./audio-io.js";
import { bakeCrossfade, fade, fitLength } from "./fit.js";
import {
  applyLevels,
  limitPeak,
  meterLevelDb,
  normalizeTo,
  speechSpans,
  type GainPlan,
} from "./levels.js";
import type { MusicPlan, MusicSection } from "./plan.js";
import { lyriaPrompt } from "./write-plan.js";

const CROSSFADE_S = 2.5;
const FIRST_FADE_IN_S = 0.6;
const AFTER_END_FADE_IN_S = 0.3;
const END_FADE_OUT_S = 1;
const FINAL_FADE_S = 0.5;

export interface MakeMusicOptions {
  plan: MusicPlan;
  words: Word[];
  rangeDurationS: number;
  speechFile: string | null;
  outDir: string;
  slider: number;
  apiKey: string;
  endpoint: string;
  model: string;
  only?: string[] | undefined;
  fetch?: typeof fetch;
  onProgress?: ((m: string) => void) | undefined;
  concurrency?: number;
  sleep?: (ms: number) => Promise<void>;
  /** The editor stopped the job: no new piece is asked for; pieces already made stay for the next make. */
  signal?: AbortSignal | undefined;
}

export interface MadeSection {
  id: string;
  file: string | null;
  clean: string | null;
  preview: string | null;
  atS: number;
  durationS: number;
  measured: { speechDb: number | null; gapDb: number | null };
  error?: string;
}

async function pool<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let t = queue.shift(); t !== undefined; t = queue.shift()) await fn(t);
    }),
  );
}

/**
 * A clip's file name for this run: s1.wav the first time, then s1-2.wav, s1-3.wav… A file the editor already
 * placed is never written over: Premiere would play the new music from the old clip and keep stale caches.
 */
function nextName(dir: string, id: string): string {
  if (!existsSync(join(dir, `${id}.wav`))) return `${id}.wav`;
  for (let v = 2; ; v++) if (!existsSync(join(dir, `${id}-${v}.wav`))) return `${id}-${v}.wav`;
}

function rawOf(dir: string, id: string): string | null {
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).find((x) => x.startsWith(`${id}.`));
  return f ? join(dir, f) : null;
}

/** The mean meter level over the given stretches of a clip, each at least 1 s; null when there are none. */
function levelOver(ch: Float32Array[], stretches: [number, number][]): number | null {
  const v = stretches
    .filter(([a, b]) => b - a >= 1)
    .map(([a, b]) => meterLevelDb(ch, SR, a, b))
    .filter(Number.isFinite);
  return v.length ? +(v.reduce((x, y) => x + y, 0) / v.length).toFixed(1) : null;
}

export async function makeScore(
  o: MakeMusicOptions,
): Promise<{ sections: MadeSection[]; priceUsd: number; record: string }> {
  const dir = join(o.outDir, "music");
  const rawDir = join(dir, "raw");
  for (const d of [dir, rawDir, join(dir, "clean"), join(dir, "preview")])
    mkdirSync(d, { recursive: true });
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const models = loadMusicCatalog().flatMap((p) => p.models);
  const priceOf = (id: string) => models.find((m) => m.id === id)?.pricePerSong ?? 0;
  let priceUsd = 0;
  const errors = new Map<string, string>();
  const sections = o.plan.sections;

  /** One Lyria piece, with the story mode's retries and one plainer try after a content refusal. */
  async function generate(model: string, prompt: string, plain: string, file: string) {
    let text = prompt;
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await generateMusic({
          apiKey: o.apiKey,
          model,
          endpoint: o.endpoint,
          prompt: text,
          ...(o.fetch ? { fetch: o.fetch } : {}),
        });
        priceUsd += priceOf(model);
        const saved = saveRawMusic(r.audio, r.mimeType, rawDir);
        const ext = saved.slice(saved.lastIndexOf("."));
        const target = `${file}${ext}`;
        rmSync(target, { force: true });
        renameSync(saved, target);
        return target;
      } catch (err) {
        if (
          err instanceof MusicError &&
          /blocked|sensitive|prohibited/i.test(err.message) &&
          text !== plain
        ) {
          text = plain;
          continue;
        }
        if (!(err instanceof MusicError) || !err.retryable || attempt >= 3) throw err;
        await sleep(2000 * attempt);
      }
    }
  }

  // 1. raw pieces: the asked sections again, any section without one yet
  const wanted = sections.filter(
    (s) => !s.silent && (o.only?.includes(s.id) || !rawOf(rawDir, s.id)),
  );
  let done = 0;
  const stopped = () => o.signal?.aborted === true;
  await pool(wanted, o.concurrency ?? 3, async (s) => {
    if (stopped()) return;
    o.onProgress?.(`Writing the music ${++done}/${wanted.length}`);
    for (const f of readdirSync(rawDir)) if (f.startsWith(`${s.id}.`)) rmSync(join(rawDir, f));
    const plainSection: MusicSection = {
      ...s,
      prompt: "Simple, calm instrumental background music.",
    };
    try {
      await generate(
        o.model,
        lyriaPrompt(o.plan, s),
        lyriaPrompt(o.plan, plainSection),
        join(rawDir, s.id),
      );
    } catch (err) {
      errors.set(s.id, err instanceof Error ? err.message : String(err));
    }
  });

  if (stopped()) throw new Error("The music was stopped.");
  o.onProgress?.("Fitting the music to the speech");
  const playable = (s: MusicSection | undefined) =>
    !!s && !s.silent && !errors.has(s.id) && !!rawOf(rawDir, s.id);

  // 2. each section's own music, long enough for a crossfade into the next one
  const own = new Map<string, Float32Array[]>();
  const outOf = new Map<string, "crossfade" | "end" | "final">();
  for (const [i, s] of sections.entries()) {
    if (!playable(s)) continue;
    const len = s.endS - s.startS;
    const next = sections[i + 1];
    const kind = s.final
      ? "final"
      : s.transitionOut === "crossfade" && playable(next)
        ? "crossfade"
        : "end";
    outOf.set(s.id, kind);
    const piece = readAudio(rawOf(rawDir, s.id)!);
    let music: Float32Array[];
    if (kind !== "final") {
      music = fitLength(piece, len + (kind === "crossfade" ? CROSSFADE_S : 0), kind === "end");
      if (kind === "end") music = fade(music, 0, END_FADE_OUT_S);
    } else {
      // the closing piece keeps its own ending, which lands on the range's last frame; a forced final hit
      // sounded worse than the model's own close (12 Oct 2026)
      music = fade(fitLength(piece, len, true), 0, FINAL_FADE_S);
    }
    const prevKind = outOf.get(sections[i - 1]?.id ?? "");
    const fadeIn = i === 0 ? FIRST_FADE_IN_S : prevKind === "crossfade" ? 0 : AFTER_END_FADE_IN_S;
    own.set(s.id, fade(music, fadeIn, 0));
  }

  // 3. crossfades baked into the next clip's head
  const clean = new Map(own);
  for (const [i, s] of sections.entries()) {
    if (outOf.get(s.id) !== "crossfade") continue;
    const next = sections[i + 1]!;
    const { prev, next: head } = bakeCrossfade(clean.get(s.id)!, clean.get(next.id)!, CROSSFADE_S);
    clean.set(s.id, prev);
    clean.set(next.id, head);
  }

  // 4. levels, files, preview, measured levels
  const spans = speechSpans(o.words);
  const gainPlan: GainPlan = { slider: o.slider, rangeDurationS: o.rangeDurationS, spans };
  const open = o.slider + 6;
  const made: MadeSection[] = [];
  for (const s of sections) {
    const base: MadeSection = {
      id: s.id,
      file: null,
      clean: null,
      preview: null,
      atS: s.startS,
      durationS: +(s.endS - s.startS).toFixed(3),
      measured: { speechDb: null, gapDb: null },
      ...(errors.has(s.id) ? { error: errors.get(s.id)! } : {}),
    };
    const music = clean.get(s.id);
    if (!music) {
      made.push(base);
      continue;
    }
    const normal = normalizeTo(music, SR, open);
    let ducked = applyLevels(normal, SR, s.startS, gainPlan, open);
    ducked = limitPeak(ducked);
    const name = nextName(dir, s.id);
    const file = join(dir, name);
    const cleanFile = join(dir, "clean", name);
    writeAudio(file, ducked);
    writeAudio(cleanFile, limitPeak(normal));
    let preview: string | null = null;
    if (o.speechFile) {
      preview = join(dir, "preview", name);
      const r = spawnSync(ffmpegPath(), [
        "-v",
        "error",
        "-y",
        "-i",
        file,
        "-i",
        o.speechFile,
        "-filter_complex",
        `[1:a]atrim=${s.startS}:${s.endS},asetpts=PTS-STARTPTS,aformat=channel_layouts=stereo,aresample=48000[v];[0:a][v]amix=inputs=2:normalize=0[m]`,
        "-map",
        "[m]",
        "-c:a",
        "pcm_s16le",
        preview,
      ]);
      if (r.status !== 0) preview = null;
    }
    // speech and gaps inside this section, in the clip's own time
    const inSection = (a: number, b: number): [number, number] => [
      Math.max(a, s.startS) - s.startS,
      Math.min(b, s.endS) - s.startS,
    ];
    const speech = spans.map((x) => inSection(x.start, x.end)).filter(([a, b]) => b > a);
    const gaps: [number, number][] = [];
    let at = s.startS;
    for (const x of spans) {
      if (x.start - at >= 2) gaps.push(inSection(at + 0.6, x.start - 0.4));
      at = Math.max(at, x.end);
    }
    if (s.endS - at >= 2) gaps.push(inSection(at + 0.6, s.endS - (s.final ? 20 : 0.4)));
    made.push({
      ...base,
      file,
      clean: cleanFile,
      preview,
      measured: { speechDb: levelOver(ducked, speech), gapDb: levelOver(ducked, gaps) },
    });
  }

  // 5. the record: what made this music, for the editor's own files
  const record = join(dir, "music.json");
  writeFileSync(
    record,
    JSON.stringify(
      {
        version: 1,
        model: o.model,
        createdAt: new Date().toISOString(),
        synthId: "All Lyria audio carries Google's inaudible SynthID watermark.",
        world: o.plan.world,
        sections: sections.map((s) => ({
          id: s.id,
          title: s.title,
          prompt: s.silent ? null : lyriaPrompt(o.plan, s),
          startS: s.startS,
          endS: s.endS,
          file: made.find((m) => m.id === s.id)?.file ?? null,
          ...(errors.has(s.id) ? { error: errors.get(s.id) } : {}),
        })),
      },
      null,
      2,
    ),
  );
  return { sections: made, priceUsd: +priceUsd.toFixed(4), record };
}
