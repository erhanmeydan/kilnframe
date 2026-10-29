// Everything the panel asks of FilmCraft, over its control channel (client.ts). It answers the same interface as
// the Resolve bridge, so the Resolve page, preload and host run unchanged. Behaviour measured on FilmCraft 0.14.0
// (29 Oct 2026):
// - Times are ticks, 254016000000 per second, from the sequence start (0). `in`/`out` are null when not set;
//   `out` is the end of the range (marking Out at 6 s reads back 6 s).
// - timeline.place leaves In/Out and the playhead alone and returns the new clip ids; sequence.addTracks returns
//   the new track ids, placed after the last track.
// - media.status gives an item's file path (null for generated media); timeline.setTrack {enabled} switches
//   video and audio tracks off for exports.
import {
  NO_SEQUENCE,
  PLACE_FAILED,
  RENDER_FAILED,
  type HiddenTrack,
  type PlacedTracks,
  type ResolveBridge,
  type ResolveSequence,
} from "../resolve/api";
import { frameFor } from "../frame";
import { isOurAnimation, isOurInsert } from "../our-files";
import { NOT_RUNNING, type FilmCraftClient } from "./client";

export const TICKS = 254_016_000_000;

interface Clip {
  clip: number;
  item: number;
  start: number;
  end: number;
  startFrame: number;
  endFrame: number;
  sourceIn: number;
}
interface Track {
  id: number;
  name: string;
  enabled: boolean;
  locked: boolean;
  items: Clip[];
}
interface Sequence {
  id: number;
  name: string;
  duration: number;
  in: number | null;
  out: number | null;
  settings: { frame_rate: { num: number; den: number }; width: number; height: number };
  video: Track[];
  audio: Track[];
}
interface ProjectNode {
  id?: number;
  item?: number;
  name: string;
  type?: string;
  children?: ProjectNode[];
}

const seconds = (ticks: number) => ticks / TICKS;
const samePath = (a: string, b: string) => a === b;

export function createFilmCraftBridge(fc: FilmCraftClient): ResolveBridge {
  /** File paths of project items: an item's media does not change while it is in the project. */
  const paths = new Map<number, string | null>();

  async function inspect(id?: string): Promise<Sequence> {
    try {
      return await fc.exec<Sequence>("sequence.inspect", id ? { item: Number(id) } : {});
    } catch (err) {
      if ((err as Error).message === NOT_RUNNING) throw err;
      throw new Error(NO_SEQUENCE, { cause: err });
    }
  }

  /** The sequence with this id, made the active one for `fn`, the previous one opened again afterwards. */
  async function onSequence<T>(id: string, fn: (s: Sequence) => Promise<T>): Promise<T> {
    const current = await inspect();
    if (String(current.id) === id) return fn(current);
    await fc.exec("sequence.open", { item: Number(id) });
    try {
      return await fn(await inspect());
    } finally {
      await fc.exec("sequence.open", { item: current.id }).catch(() => undefined);
    }
  }

  const fpsOf = (s: Sequence) => s.settings.frame_rate.num / s.settings.frame_rate.den;
  const frame = (s: Sequence, secs: number) => Math.round(secs * fpsOf(s));
  /** Ticks of a whole number of frames: lengths that end on a frame. */
  const frameTicks = (s: Sequence, frames: number) =>
    Math.round((frames * TICKS * s.settings.frame_rate.den) / s.settings.frame_rate.num);

  async function pathOf(item: number): Promise<string | null> {
    if (!paths.has(item)) {
      const st = await fc.exec<{ path: string | null }[]>("media.status", { item }).catch(() => []);
      paths.set(item, st[0]?.path ?? null);
    }
    return paths.get(item) ?? null;
  }

  function describe(s: Sequence, projectName: string): ResolveSequence {
    const { num, den } = s.settings.frame_rate;
    return {
      id: String(s.id),
      name: s.name,
      projectName,
      fps: den === 1 ? String(num) : `${num}/${den}`,
      fpsValue: num / den,
      width: s.settings.width,
      height: s.settings.height,
      startFrame: 0,
      inSeconds: s.in !== null ? seconds(s.in) : 0,
      outSeconds: s.out !== null ? seconds(s.out) : seconds(s.duration),
      endSeconds: seconds(s.duration),
      videoTracks: s.video.length,
      audioTracks: s.audio.length,
    };
  }

  async function exportMedia(params: Record<string, unknown>): Promise<boolean> {
    try {
      await fc.exec("file.exportMedia", { range: "custom", wait: true, ...params });
      return true;
    } catch (err) {
      if ((err as Error).message === NOT_RUNNING) throw err;
      throw new Error(RENDER_FAILED, { cause: err });
    }
  }

  /** The bin "Kilnframe" at the project's top, made when missing. */
  async function kilnframeBin(): Promise<number> {
    const p = await fc.exec<{ root: ProjectNode }>("project.inspect");
    const found = p.root.children?.find(
      (c) => c.children && c.name === "Kilnframe" && c.id !== undefined,
    );
    if (found?.id !== undefined) return found.id;
    return (await fc.exec<{ bin: number }>("file.newBin", { name: "Kilnframe" })).bin;
  }

  async function importFiles(files: string[]): Promise<number[]> {
    const r = await fc.exec<{ items: number[]; errors: unknown[] }>("file.import", {
      paths: files,
      bin: await kilnframeBin(),
    });
    if (r.items.length !== files.length) throw new Error(PLACE_FAILED);
    files.forEach((f, i) => paths.set(r.items[i]!, f));
    return r.items;
  }

  /** New tracks after the last ones; their ids. */
  async function addTracks(
    video: number,
    audio: number,
  ): Promise<{ video: number[]; audio: number[] }> {
    return fc.exec("sequence.addTracks", { video, audio });
  }

  /** Places one clip and checks it landed where asked; throws PLACE_FAILED (the clip taken off) otherwise. */
  async function place(
    s: Sequence,
    opts: {
      item: number;
      track: number;
      kind: "video" | "audio";
      atFrame: number;
      sourceIn: number;
      frames: number;
    },
  ): Promise<number> {
    const r = await fc.exec<{ clips: number[] }>("timeline.place", {
      item: opts.item,
      track: opts.track,
      frame: opts.atFrame,
      insert: false,
      sourceIn: opts.sourceIn,
      duration: frameTicks(s, opts.frames),
      video: opts.kind === "video",
      audio: opts.kind === "audio",
    });
    const after = await inspect(String(s.id));
    const tracks = opts.kind === "video" ? after.video : after.audio;
    const ok = r.clips.some((c) =>
      tracks
        .find((t) => t.id === opts.track)
        ?.items.some((i) => i.clip === c && i.startFrame === opts.atFrame),
    );
    if (!ok) {
      if (r.clips.length) await fc.exec("edit.clear", { clips: r.clips }).catch(() => undefined);
      throw new Error(PLACE_FAILED);
    }
    return r.clips[0]!;
  }

  async function deleteTracks(ids: number[]) {
    for (const id of ids)
      await fc.exec("sequence.deleteTrack", { track: id }).catch(() => undefined);
  }

  /** The clips of `mediaPath` on the video track starting at `atS` and lasting `durationS`, each within a frame. */
  async function captionClips(
    s: Sequence,
    track: Track,
    mediaPath: string,
    atS: number,
    durationS: number,
  ) {
    const found: Clip[] = [];
    const f = 1 / fpsOf(s);
    for (const c of track.items) {
      const path = await pathOf(c.item);
      if (!path || !samePath(path, mediaPath)) continue;
      if (
        Math.abs(seconds(c.start) - atS) < f &&
        Math.abs(seconds(c.end - c.start) - durationS) < f
      )
        found.push(c);
    }
    return found;
  }

  return {
    async currentSequence() {
      const s = await inspect();
      const p = await fc.exec<{ name: string }>("project.inspect");
      return describe(s, p.name || "FilmCraft");
    },

    async renderSettingsLost() {
      return false;
    },

    async quickRange() {
      const s = await inspect();
      const d = describe(s, "");
      return {
        id: d.id,
        inSeconds: d.inSeconds,
        outSeconds: d.outSeconds,
        endSeconds: d.endSeconds,
      };
    },

    async exportRangeAudio(id, startS, endS, file) {
      const ok = await exportMedia({
        path: file,
        sequence: Number(id),
        format: "wav",
        startSeconds: startS,
        endSeconds: endS,
      });
      return { ok, offsetSeconds: startS };
    },

    exportRangePicture(id, startS, endS, file) {
      return onSequence(id, async (s) => {
        const half = (n: number) => Math.round(n / 4) * 2;
        return exportMedia({
          path: file,
          sequence: Number(id),
          format: "h264",
          audio: false,
          width: half(s.settings.width),
          height: half(s.settings.height),
          startSeconds: startS,
          endSeconds: endS,
        });
      });
    },

    async exportFrame(id, secs, file) {
      const ext = (/\.([a-z]+)$/i.exec(file)?.[1] ?? "png").toLowerCase();
      await fc.exec("file.exportFrame", {
        path: file,
        format: ext === "jpg" ? "jpeg" : ext,
        target: "program",
        sequence: Number(id),
        time: Math.round(secs * TICKS),
      });
      return true;
    },

    async cancelExports() {
      await fc.exec("export.queue.cancel", {}).catch(() => undefined);
    },

    async isRendering() {
      return false;
    },

    hideOurInserts(id, startS, endS) {
      return onSequence(id, async (s) => {
        const from = startS * TICKS;
        const to = endS * TICKS;
        const hidden: HiddenTrack[] = [];
        for (const type of ["video", "audio"] as const)
          for (const [i, t] of s[type].entries()) {
            if (!t.enabled) continue;
            let ours = false;
            for (const c of t.items) {
              if (c.end <= from || c.start >= to) continue;
              const path = await pathOf(c.item);
              if (path && isOurInsert(path)) ours = true;
            }
            if (ours) {
              await fc.exec("timeline.setTrack", { track: t.id, enabled: false });
              hidden.push({ type, index: i + 1 });
            }
          }
        return hidden;
      });
    },

    showTracks(id, tracks) {
      return onSequence(id, async (s) => {
        for (const t of tracks) {
          const track = s[t.type][t.index - 1];
          if (track) await fc.exec("timeline.setTrack", { track: track.id, enabled: true });
        }
      });
    },

    placeInsert(id, files, atS, handlesS, durationS, tracks) {
      return onSequence(id, async (s) => {
        const [video, sfx] = await importFiles(
          files.sfx ? [files.video, files.sfx] : [files.video],
        );
        const added: number[] = [];
        let v: Track | undefined;
        let a: Track | undefined;
        if (tracks) {
          v = s.video[tracks.videoTrack];
          a = s.audio[tracks.audioTrack];
        } else {
          // a sequence with one empty video track (a story sequence Kilnframe made) takes the insert on V1; an
          // audio track of our own even without sound effects, so a later part's effects never land on the
          // editor's own audio
          const empty = s.video.length === 1 && !s.video[0]!.items.length;
          const made = await addTracks(empty ? 0 : 1, 1);
          added.push(...made.video, ...made.audio);
          const now = await inspect(id);
          v = empty ? now.video[0] : now.video.find((t) => t.id === made.video[0]);
          a = now.audio.find((t) => t.id === made.audio[0]);
        }
        if (!v || !a || v.locked || a.locked) {
          await deleteTracks(added);
          throw new Error(PLACE_FAILED);
        }
        const handles = frameTicks(s, Math.round(handlesS * fpsOf(s)));
        const frames = frame(s, durationS);
        const atFrame = frame(s, atS);
        const placed: number[] = [];
        try {
          placed.push(
            await place(s, {
              item: video!,
              track: v.id,
              kind: "video",
              atFrame,
              sourceIn: handles,
              frames,
            }),
          );
          if (sfx !== undefined)
            placed.push(
              await place(s, {
                item: sfx,
                track: a.id,
                kind: "audio",
                atFrame,
                sourceIn: handles,
                frames,
              }),
            );
        } catch (err) {
          if (placed.length) await fc.exec("edit.clear", { clips: placed }).catch(() => undefined);
          await deleteTracks(added);
          throw err;
        }
        const after = await inspect(id);
        return {
          videoTrack: after.video.findIndex((t) => t.id === v.id),
          audioTrack: after.audio.findIndex((t) => t.id === a.id),
        } satisfies PlacedTracks;
      });
    },

    placeAudioClips(id, clips) {
      return onSequence(id, async (s) => {
        const items = await importFiles(clips.map((c) => c.file));
        const made = await addTracks(0, 1);
        const track = made.audio[0]!;
        const placed: number[] = [];
        try {
          for (const [i, c] of clips.entries()) {
            // start and end rounded to frames from the sequence time: clips that meet in seconds meet in frames
            const from = frame(s, c.atS);
            const to = frame(s, c.atS + c.durationS);
            placed.push(
              await place(s, {
                item: items[i]!,
                track,
                kind: "audio",
                atFrame: from,
                sourceIn: 0,
                frames: to - from,
              }),
            );
          }
        } catch (err) {
          if (placed.length) await fc.exec("edit.clear", { clips: placed }).catch(() => undefined);
          await deleteTracks([track]);
          throw err;
        }
        const after = await inspect(id);
        return { audioTrack: after.audio.findIndex((t) => t.id === track) };
      });
    },

    ourInsertSpans(id) {
      return onSequence(id, async (s) => {
        const spans: { startS: number; endS: number }[] = [];
        for (const t of s.video)
          for (const c of t.items) {
            const path = await pathOf(c.item);
            if (path && isOurAnimation(path))
              spans.push({ startS: seconds(c.start), endS: seconds(c.end) });
          }
        return spans.sort((x, y) => x.startS - y.startS);
      });
    },

    findCaptionClip(id, mediaPath, atS, durationS) {
      return onSequence(id, async (s) => {
        for (const [i, t] of s.video.entries())
          if ((await captionClips(s, t, mediaPath, atS, durationS)).length)
            return { videoTrack: i };
        return null;
      });
    },

    replaceCaptionClip(id, earlier, file, atS, durationS, videoTrack) {
      return onSequence(id, async (s) => {
        const track = s.video[videoTrack];
        if (!track || track.locked) throw new Error(PLACE_FAILED);
        const old = await captionClips(s, track, earlier.path, earlier.atS, earlier.durationS);
        // moved, trimmed or gone since it was found: nothing goes onto that track
        if (!old.length) return false;
        const [item] = await importFiles([file]);
        await fc.exec("edit.clear", { clips: old.map((c) => c.clip) });
        const from = frame(s, atS);
        const to = frame(s, atS + durationS);
        try {
          await place(s, {
            item: item!,
            track: track.id,
            kind: "video",
            atFrame: from,
            sourceIn: 0,
            frames: to - from,
          });
        } catch (err) {
          // the old clips back where they lay
          for (const c of old)
            await place(s, {
              item: c.item,
              track: track.id,
              kind: "video",
              atFrame: c.startFrame,
              sourceIn: c.sourceIn,
              frames: c.endFrame - c.startFrame,
            }).catch(() => undefined);
          throw err;
        }
        return true;
      });
    },

    async createStorySequence(templateId, name, narration, music, format) {
      const template = await inspect(templateId);
      const w = template.settings.width;
      const h = template.settings.height;
      const size = format ? frameFor(format, w, h) : { width: w, height: h };
      const [voice, bed] = await importFiles(music ? [narration, music] : [narration]);
      await fc.exec("file.newSequence", {
        name,
        width: size.width,
        height: size.height,
        fps: fpsOf(template),
        sampleRate: 48000,
        video: 1,
        audio: bed !== undefined ? 2 : 1,
      });
      // the new sequence is the active one
      const s = await inspect();
      const whole = async (item: number, track: Track) => {
        const r = await fc.exec<{ clips: number[] }>("timeline.place", {
          item,
          track: track.id,
          frame: 0,
          insert: false,
          video: false,
          audio: true,
        });
        if (!r.clips.length) throw new Error(PLACE_FAILED);
      };
      await whole(voice!, s.audio[0]!);
      if (bed !== undefined) await whole(bed, s.audio[1]!);
    },
  };
}
