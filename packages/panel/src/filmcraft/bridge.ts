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
  COPY_LEFT,
  CUT_FAILED,
  CUT_UNSUPPORTED,
  EXPORTS_STOPPED,
  NO_SEQUENCE,
  NOT_RUNNING,
  PLACE_FAILED,
  RENDER_FAILED,
  UNSET_MARK,
  type HiddenTrack,
  type PlacedTracks,
  type ResolveBridge,
  type ResolveSequence,
} from "../resolve/api";
import { frameCuts, newEndF, piecesOf, type FrameCut } from "../cut-plan";
import { frameFor, insertScale } from "../frame";
import { isOurAnimation, isOurInsert, isVoiceFixTake } from "../our-files";
import { CONNECTION_LOST, TIMED_OUT, type FilmCraftClient } from "./client";

export const TICKS = 254_016_000_000;
/** The longest an export may take before the job gives up on it. */
const EXPORT_LIMIT_MS = 30 * 60_000;

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
  /** The length in frames (0.16.0). */
  durationFrames?: number;
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
/** Every project item named `name`, through the bins. */
const itemsNamed = (node: ProjectNode, name: string, out: number[] = []): number[] => {
  if (node.item !== undefined && node.name === name) out.push(node.item);
  for (const c of node.children ?? []) itemsNamed(c, name, out);
  return out;
};
/** The channel failed, not the command: said as it is, never as a missing sequence or a failed render. */
const channelError = (err: unknown) =>
  [NOT_RUNNING, CONNECTION_LOST, TIMED_OUT].includes((err as Error).message);
/** True when two paths name the same file: Mac and Windows file systems ignore letter case. */
const samePath = (a: string, b: string) => {
  const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
  return norm(a) === norm(b);
};

/** The engine commands a pause cut needs (FilmCraft 0.16.0). */
const CUT_COMMANDS = ["sequence.simplify", "markers.markIn", "markers.markOut", "sequence.extract"];

/** Every edit point of every track, in frames, as `piecesOf` says they lie after the cuts. */
function editPoints(s: Sequence, cuts: FrameCut[] | null): number[][] {
  const { num, den } = s.settings.frame_rate;
  const f = (ticks: number) => Math.round((ticks * num) / (den * TICKS));
  return [...s.video, ...s.audio].map((t) =>
    t.items
      .flatMap((c) =>
        cuts
          ? piecesOf(
              { key: "", track: 0, kind: "video", startF: f(c.start), endF: f(c.end) },
              cuts,
            ).map((p) => [p.newStartF, p.newStartF + p.toF - p.fromF])
          : [[f(c.start), f(c.end)]],
      )
      .sort((a, b) => a[0]! - b[0]!)
      .flat(),
  );
}

export function createFilmCraftBridge(fc: FilmCraftClient): ResolveBridge {
  /** File paths of project items: an item's media does not change while it is in the project. */
  const paths = new Map<number, string | null>();
  /** Counts the editor's stops: an export waiting when it changes ends. */
  let stops = 0;
  const stopWaits = new Set<() => void>();
  /** How far the running cut got, for cutProgress; null when none runs. */
  let cutting: { done: number; total: number } | null = null;

  /** The engine's commands and their params as engine.commands lists them; null when it cannot say. */
  async function commandList(): Promise<Map<string, string> | null> {
    try {
      const r = await fc.call("engine.commands");
      const list = Array.isArray(r) ? r : (r as { commands?: unknown } | null)?.commands;
      if (!Array.isArray(list)) return null;
      return new Map(
        (list as { id?: unknown; params?: unknown }[])
          .filter((c) => typeof c.id === "string")
          .map((c) => [c.id as string, typeof c.params === "string" ? c.params : ""]),
      );
    } catch (err) {
      if (channelError(err)) throw err;
      return null;
    }
  }

  async function inspect(id?: string): Promise<Sequence> {
    try {
      return await fc.exec<Sequence>("sequence.inspect", id ? { item: Number(id) } : {}, {
        shared: true,
      });
    } catch (err) {
      if (channelError(err)) throw err;
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
  /** A time in ticks as a frame of the sequence. */
  const frameAt = (s: Sequence, ticks: number) => frame(s, seconds(ticks));
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
      inSeconds: s.in != null ? seconds(s.in) : UNSET_MARK,
      outSeconds: s.out != null ? seconds(s.out) : UNSET_MARK,
      endSeconds: seconds(s.duration),
      videoTracks: s.video.length,
      audioTracks: s.audio.length,
    };
  }

  /** An export FilmCraft finishes before replying; a stop ends the wait at once (EXPORTS_STOPPED). */
  async function exportMedia(params: Record<string, unknown>): Promise<boolean> {
    const stopsBefore = stops;
    let stopWait = () => undefined as void;
    const stopped = new Promise<never>((_, fail) => {
      stopWait = () => fail(new Error(EXPORTS_STOPPED));
    });
    stopWaits.add(stopWait);
    try {
      await Promise.race([
        fc.exec(
          "file.exportMedia",
          { range: "custom", wait: true, ...params },
          { timeoutMs: EXPORT_LIMIT_MS },
        ),
        stopped,
      ]);
      if (stops !== stopsBefore) throw new Error(EXPORTS_STOPPED);
      return true;
    } catch (err) {
      if (stops !== stopsBefore) throw new Error(EXPORTS_STOPPED, { cause: err });
      if (channelError(err)) throw err;
      // FilmCraft's own reason in the message: a cause does not cross from the app to the panel window, and
      // without it a report said only that the export failed (1 Nov 2026, Windows)
      const why = err instanceof Error ? err.message : String(err);
      throw new Error(`${RENDER_FAILED}: ${why}`, { cause: err });
    } finally {
      stopWaits.delete(stopWait);
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
    const clear = () =>
      r.clips.length ? fc.exec("edit.clear", { clips: r.clips }).catch(() => undefined) : undefined;
    let after: Sequence;
    try {
      after = await inspect(String(s.id));
    } catch (err) {
      await clear();
      throw err;
    }
    const tracks = opts.kind === "video" ? after.video : after.audio;
    const ok = r.clips.some((c) =>
      tracks
        .find((t) => t.id === opts.track)
        ?.items.some((i) => i.clip === c && i.startFrame === opts.atFrame),
    );
    if (!ok) {
      await clear();
      throw new Error(PLACE_FAILED);
    }
    return r.clips[0]!;
  }

  /**
   * A clip rendered at 4K for a sequence larger than that (frame.ts insertScale) is fitted to the frame with
   * clip.fitToFrame, which sets its Motion scale and does not toggle (clip.scaleToFrameSize would). False when
   * FilmCraft refused it (an older FilmCraft without the command): the caller says how to do it by hand.
   */
  async function fitToFrame(s: Sequence, clip: number): Promise<boolean> {
    if (insertScale(s.settings.width, s.settings.height) <= 1) return true;
    try {
      await fc.exec("clip.fitToFrame", { clips: [clip] });
      return true;
    } catch (err) {
      if (channelError(err)) throw err;
      return false;
    }
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
      stops++;
      for (const stopWait of stopWaits) stopWait();
      // on a connection of its own: the export holds the shared one until it ends
      await fc
        .exec("export.queue.cancel", {}, { alone: true, timeoutMs: 5_000 })
        .catch(() => undefined);
    },

    async isRendering() {
      return false;
    },

    hideOurInserts(id, startS, endS) {
      return onSequence(id, async (s) => {
        const from = startS * TICKS;
        const to = endS * TICKS;
        const hidden: HiddenTrack[] = [];
        const off: number[] = [];
        try {
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
                off.push(t.id);
                hidden.push({ type, index: i + 1 });
              }
            }
        } catch (err) {
          // the caller never learns which tracks went off: they go back on here
          for (const track of off)
            await fc.exec("timeline.setTrack", { track, enabled: true }).catch(() => undefined);
          throw err;
        }
        return hidden;
      });
    },

    speechTracks(id, startS, endS) {
      return onSequence(id, async (s) => {
        const from = startS * TICKS;
        const to = endS * TICKS;
        const found: number[] = [];
        for (const [i, t] of s.audio.entries()) {
          if (!t.enabled) continue;
          for (const c of t.items) {
            if (c.end <= from || c.start >= to) continue;
            const path = await pathOf(c.item);
            // generated media has no file and is the editor's own
            if (!path || !(isOurInsert(path) || isVoiceFixTake(path))) {
              found.push(i);
              break;
            }
          }
        }
        return found;
      });
    },

    soloAudioTrack(id, track) {
      return onSequence(id, async (s) => {
        const hidden: HiddenTrack[] = [];
        const off: number[] = [];
        try {
          for (const [i, t] of s.audio.entries()) {
            if (i === track || !t.enabled) continue;
            await fc.exec("timeline.setTrack", { track: t.id, enabled: false });
            off.push(t.id);
            hidden.push({ type: "audio", index: i + 1 });
          }
        } catch (err) {
          // the caller never learns which tracks went off: they go back on here
          for (const t of off)
            await fc.exec("timeline.setTrack", { track: t, enabled: true }).catch(() => undefined);
          throw err;
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
        const placed: number[] = [];
        try {
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
          if (!v || !a || v.locked || a.locked) throw new Error(PLACE_FAILED);
          const handles = frameTicks(s, Math.round(handlesS * fpsOf(s)));
          const frames = frame(s, durationS);
          const atFrame = frame(s, atS);
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
          const fitted = await fitToFrame(s, placed[0]!);
          const after = await inspect(id);
          return {
            videoTrack: after.video.findIndex((t) => t.id === v.id),
            audioTrack: after.audio.findIndex((t) => t.id === a.id),
            ...(fitted
              ? {}
              : {
                  scaleByHand: Math.round(insertScale(s.settings.width, s.settings.height) * 100),
                }),
          } satisfies PlacedTracks;
        } catch (err) {
          // nothing half made stays behind, also when FilmCraft went away (each undo then fails fast)
          if (placed.length) await fc.exec("edit.clear", { clips: placed }).catch(() => undefined);
          await deleteTracks(added);
          throw err;
        }
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
          const after = await inspect(id);
          return { audioTrack: after.audio.findIndex((t) => t.id === track) };
        } catch (err) {
          if (placed.length) await fc.exec("edit.clear", { clips: placed }).catch(() => undefined);
          await deleteTracks([track]);
          throw err;
        }
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
          const clip = await place(s, {
            item: item!,
            track: track.id,
            kind: "video",
            atFrame: from,
            sourceIn: 0,
            frames: to - from,
          });
          await fitToFrame(s, clip);
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
        // FilmCraft snaps a rate within 0.005 of a standard one to that exact rational (29.97002997 is
        // 30000/1001: FrameRate::from_f64, crates/time), so the story sequence keeps the template's grid
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

    // The editor's own Extract on a copy: sequence.simplify with every option off copies the sequence whole
    // (effects, titles, links) and opens the copy; each pause is marked In to Out and extracted, which cuts all
    // tracks and closes the gap (measured on 0.16.0). Last pause first, so the earlier frames stay where they
    // were. The editor's sequence is never touched.
    async cutToNewTimeline(id, cuts, name) {
      const listed = await commandList();
      if (!listed || CUT_COMMANDS.some((c) => !listed.has(c))) throw new Error(CUT_UNSUPPORTED);
      const editorSeq = await inspect();
      const source = String(editorSeq.id) === id ? editorSeq : await inspect(id);
      const fps = fpsOf(source);
      const length = source.durationFrames ?? frame(source, seconds(source.duration));
      const frames = frameCuts(cuts, fps, length);
      const removed = frames.reduce((n, c) => n + c.endF - c.startF, 0);

      if (source !== editorSeq) await fc.exec("sequence.open", { item: source.id });
      // items already named like the copy: one that appears after a failed simplify is the copy
      const namedBefore = new Set(
        itemsNamed((await fc.exec<{ root: ProjectNode }>("project.inspect")).root, name),
      );
      let copy: number | null = null;
      cutting = { done: 0, total: frames.length };
      try {
        const made = await fc.exec<{ sequence: number; name: string }>("sequence.simplify", {
          name,
          removeDisabled: false,
          removeEmptyTracks: false,
          closeGaps: false,
          moveClipsDown: false,
          removeVideoEffects: false,
          removeAudioEffects: false,
          removeText: false,
        });
        copy = made.sequence;
        // simplify opens the copy; said again so a mark can never land on the editor's sequence
        await fc.exec("sequence.open", { item: copy });
        for (const c of [...frames].reverse()) {
          await fc.exec("markers.markIn", { frame: c.startF, target: "program" });
          // the Out frame is extracted too (In 48, Out 72 took 25 frames on 0.16.0): the last frame of the
          // pause, not the first one kept
          await fc.exec("markers.markOut", { frame: c.endF - 1, target: "program" });
          await fc.exec("sequence.extract", {});
          cutting.done++;
        }
        // extract clears them itself (0.16.0); an older or newer one may not
        await fc.exec("markers.clearInOut", { target: "program" });

        // every track must have followed: a locked track or an Out read one frame off shows here
        const after = await inspect(String(copy));
        const afterLength = after.durationFrames ?? frame(after, seconds(after.duration));
        const want = editPoints(source, frames);
        const got = editPoints(after, null);
        const same =
          afterLength === length - removed &&
          want.length === got.length &&
          want.every(
            (w, i) =>
              w.length === got[i]!.length && w.every((v, j) => Math.abs(v - got[i]![j]!) <= 1),
          );
        if (!same)
          throw new Error(
            `${CUT_FAILED}: the copy is ${afterLength} frames, ${length - removed} expected, or a track did not follow the cut`,
          );
        // the editor's In and Out follow their content (a mark inside a pause goes to its edge). Out is the
        // last frame of the range here, as extract showed; a lost mark is not worth failing the cut for
        const mark = (command: string, f: number) =>
          fc.exec(command, { frame: Math.max(0, f), target: "program" }).catch(() => undefined);
        if (source.in != null)
          await mark("markers.markIn", newEndF(frameAt(source, source.in), frames));
        if (source.out != null)
          await mark("markers.markOut", newEndF(frameAt(source, source.out) + 1, frames) - 1);
        return { id: String(copy), name: after.name || made.name, leftOut: 0, rebuilt: false };
      } catch (err) {
        await fc.exec("sequence.open", { item: editorSeq.id }).catch(() => undefined);
        // simplify failed after making its copy: found by its name, as an item that was not there before
        if (copy === null && !channelError(err)) {
          const made = await fc
            .exec<{ root: ProjectNode }>("project.inspect")
            .then((p) => itemsNamed(p.root, name).filter((i) => !namedBefore.has(i)))
            .catch(() => []);
          if (made.length === 1) copy = made[0]!;
        }
        let left = false;
        if (copy !== null) {
          // only with a shape FilmCraft lists: a guessed one might fall back to the editor's selection.
          // Measured on 0.16.0: project.delete {items:[seq]} deleted that sequence ({items:1})
          const params = listed.get("project.delete") ?? "";
          const what = /"items"\s*:\s*\[/.test(params)
            ? { items: [copy] }
            : /"item"\s*:/.test(params)
              ? { item: copy }
              : null;
          left =
            !what ||
            !(await fc.exec("project.delete", what).then(
              () => true,
              () => false,
            ));
        }
        if (channelError(err)) throw err;
        // FilmCraft's own reason in the message: a cause does not cross from the app to the panel window
        const why = (err instanceof Error ? err.message : String(err)).replace(
          new RegExp(`^${CUT_FAILED}: `),
          "",
        );
        const leftNote = left ? `${COPY_LEFT}=${JSON.stringify(name)}: ` : "";
        throw new Error(`${CUT_FAILED}: ${leftNote}${why}`, { cause: err });
      } finally {
        cutting = null;
      }
    },

    async cutProgress() {
      return cutting && { ...cutting };
    },
  };
}
