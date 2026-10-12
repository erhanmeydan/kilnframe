// The music-make step: one Lyria piece per section, fitted to its section, joined (a crossfade is baked into
// the next clip's head), ducked under the speech by the level curve, and the closing hit put on its mark.
// Raw pieces are kept per section, so making one section again re-cuts its neighbours without Lyria.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ffmpegPath } from "../../config.js";
import type { Word } from "../../schemas/transcript.js";
import { generateMusic, loadMusicCatalog, MusicError, saveRawMusic } from "../index.js";
import { readAudio, SR, writeAudio } from "./audio-io.js";
import { alignFinal, findHit } from "./final.js";
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
const HIT_LIFT_DB = 9;

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
  clipModel: string;
  only?: string[] | undefined;
  fetch?: typeof fetch;
  onProgress?: ((m: string) => void) | undefined;
  concurrency?: number;
  sleep?: (ms: number) => Promise<void>;
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

const cut = (ch: Float32Array[], from: number, to: number) => ch.map((c) => c.slice(from, to));
const concat = (a: Float32Array[], b: Float32Array[]) =>
  a.map((c, k) => {
    const o = new Float32Array(c.length + b[k]!.length);
    o.set(c);
    o.set(b[k]!, c.length);
    return o;
  });
const add = (a: Float32Array[], b: Float32Array[]) =>
  a.map((c, k) => c.map((v, i) => v + (b[k]![i] ?? 0)));

/** Scales the stretch from `fromS` on so its peak is at most `peakDb` (the final hit). */
function capFrom(ch: Float32Array[], fromS: number, peakDb: number): Float32Array[] {
  const from = Math.max(0, Math.round(fromS * SR));
  let p = 0;
  for (const c of ch) for (let i = from; i < c.length; i++) p = Math.max(p, Math.abs(c[i]!));
  const ceiling = 10 ** (peakDb / 20);
  if (p <= ceiling) return ch;
  const g = ceiling / p;
  return ch.map((c) => {
    const o = c.slice();
    for (let i = from; i < o.length; i++) o[i]! *= g;
    return o;
  });
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
  await pool(wanted, o.concurrency ?? 3, async (s) => {
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

  o.onProgress?.("Fitting the music to the speech");
  const playable = (s: MusicSection | undefined) =>
    !!s && !s.silent && !errors.has(s.id) && !!rawOf(rawDir, s.id);
  const lastWordEnd = o.words.length ? o.words.at(-1)!.end : null;

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
      const ruleEnd = lastWordEnd ?? -Infinity;
      const hitAt = (ruleEnd >= o.rangeDurationS - 3 ? ruleEnd : o.rangeDurationS - 2) - s.startS;
      const hitS = findHit(piece);
      if (hitS !== null) {
        // enough music before the hit: the part ahead of it is looped when the piece is short of it
        const before = cut(piece, 0, Math.round(hitS * SR));
        const after = cut(piece, Math.round(hitS * SR), piece[0]!.length);
        const lead = hitS < hitAt ? fitLength(before, hitAt, false) : before;
        music = alignFinal({
          music: concat(lead, after),
          hitS: lead[0]!.length / SR,
          sectionStartS: s.startS,
          rangeDurationS: o.rangeDurationS,
          lastWordEndS: lastWordEnd,
        });
      } else {
        // no hit in the piece: a separate hit from the clip model, the section's music fading into it
        let clipFile: string | null;
        try {
          clipFile = await generate(
            o.clipModel,
            `A single big final hit with a natural decay, nothing before it. ${o.plan.world}. Instrumental only.`,
            "A single big orchestral hit with a natural decay. Instrumental only.",
            join(rawDir, `${s.id}-hit`),
          );
        } catch {
          clipFile = null;
        }
        const stop = Math.min(len, Math.max(0.5, hitAt));
        const body = fade(
          cut(fitLength(piece, len, false), 0, Math.round(stop * SR)),
          0,
          Math.min(1, stop),
        );
        const silence = body.map(() => new Float32Array(Math.round(len * SR) - body[0]!.length));
        music = concat(body, silence);
        if (clipFile) {
          const clip = readAudio(clipFile);
          const clipHit = findHit(clip, 0) ?? 0;
          music = add(
            music,
            alignFinal({
              music: clip,
              hitS: clipHit,
              sectionStartS: s.startS,
              rangeDurationS: o.rangeDurationS,
              lastWordEndS: lastWordEnd,
            }),
          );
        }
      }
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
    if (s.final) {
      const hitFrom = Math.max(0, (findHit(ducked) ?? s.endS - s.startS) - 0.05);
      ducked = capFrom(ducked, hitFrom, Math.min(o.slider + HIT_LIFT_DB, -1.5));
    }
    ducked = limitPeak(ducked);
    const file = join(dir, `${s.id}.wav`);
    const cleanFile = join(dir, "clean", `${s.id}.wav`);
    writeAudio(file, ducked);
    writeAudio(cleanFile, limitPeak(normal));
    let preview: string | null = null;
    if (o.speechFile) {
      preview = join(dir, "preview", `${s.id}.wav`);
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
