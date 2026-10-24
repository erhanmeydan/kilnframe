// The Premiere Pro host: the UXP API (@adobe/premierepro 26.5) behind the panel's Host interface. Every call
// here is written from the official type definitions; the probe panel confirms the behaviour inside Premiere.
import type {
  FolderItem,
  Project,
  ProjectItem,
  Sequence,
  TrackItemSelection,
  premierepro,
} from "@adobe/premierepro";
import { frameFor } from "./frame";
import { formatRational, rationalFps } from "./fps";
import { withoutLongPathPrefix } from "./home";
import type { Host, HostSequence, PlaceResult } from "./host";
import { t } from "./i18n";
import { isOurAnimation, isOurInsert } from "./our-files";

export interface UxpModule {
  host?: { uiLocale?: string };
  versions?: { plugin?: unknown };
  shell: { openExternal(url: string): Promise<unknown> };
  storage: {
    localFileSystem: {
      getFileForOpening(o: {
        allowMultiple: boolean;
        types: string[];
      }): Promise<{ nativePath: string }[] | { nativePath: string } | null>;
      getFileForSaving(
        suggestedName: string,
        o: { types: string[] },
      ): Promise<{ nativePath: string; write(data: string): Promise<unknown> } | null>;
    };
  };
}
export interface FsModule {
  readFile(path: string, options: { encoding: string }): Promise<string>;
  writeFile(path: string, data: string, options: { encoding: string }): Promise<void>;
  lstat(path: string): Promise<unknown>;
}
export interface OsModule {
  homedir(): string | null;
  platform?: () => string;
}

interface SequenceInfo {
  name: string;
  inSeconds: number;
  outSeconds: number;
  fps: string;
  fpsValue: number;
  width: number;
  height: number;
  videoTracks: number;
  audioTracks: number;
}

/** A clip on a track, as far as the panel reads it. */
interface Clip {
  getStartTime(): Promise<{ seconds: number }>;
  getEndTime(): Promise<{ seconds: number }>;
  getProjectItem(): Promise<ProjectItem>;
}

/** A track that can be switched off for an export (video and audio tracks both can). */
interface Mutable {
  isMuted(): Promise<boolean>;
  setMute(mute: boolean): Promise<boolean>;
  getTrackItems(type: number, includeEmpty: boolean): Clip[];
}

const isWin = (os: OsModule) =>
  os.platform ? os.platform() === "win32" : /^[a-z]:/i.test(os.homedir() ?? "");

/**
 * A path as the operating system writes it, for Premiere's own calls. The panel keeps paths with "/", which
 * Premiere on Windows turns into \\?\C:\...\Kilnframe/job/sequence.wav, and Windows refuses a "/" after that
 * prefix ("Unable To Delete Existing File", 11 Oct 2026).
 */
const nativePathFor = (os: OsModule, path: string) =>
  isWin(os) ? path.replace(/\//g, "\\") : path;

/** True when two paths name the same file, whichever slashes and letter case Windows gave them. */
const samePathFor = (os: OsModule, a: string, b: string) => {
  if (!isWin(os)) return a === b;
  const norm = (p: string) => p.replace(/\//g, "\\").toLowerCase();
  return norm(a) === norm(b);
};

export function createPremiereHost(
  ppro: premierepro,
  uxp: UxpModule,
  fs: FsModule,
  os: OsModule,
): Host {
  const native = (p: string) => nativePathFor(os, p);
  const same = (a: string, b: string) => samePathFor(os, a, b);

  async function activeProject(): Promise<Project> {
    const project = await ppro.Project.getActiveProject();
    if (!project) throw new Error(t("seq.noProject"));
    return project;
  }

  /**
   * The project and sequence each HostSequence was read from. A job keeps working on them when the editor
   * switches to another sequence or another open project meanwhile, as the panel did when it held them itself.
   */
  const known = new Map<string, { project: Project; sequence: Sequence }>();

  /** The Sequence behind a HostSequence: the one it was read from, else found again by guid. */
  async function sequenceOf(seq: HostSequence): Promise<{ project: Project; sequence: Sequence }> {
    const kept = known.get(seq.id);
    if (kept) {
      // still in its project: not deleted, and the project not closed
      const there = await kept.project.getSequences().catch(() => []);
      if (there.some((s) => s.guid.toString() === seq.id)) return kept;
      known.delete(seq.id);
      throw new Error(t("seq.noSequence"));
    }
    const project = await activeProject();
    const active = await project.getActiveSequence();
    if (active && active.guid.toString() === seq.id) return { project, sequence: active };
    const found = (await project.getSequences()).find((s) => s.guid.toString() === seq.id);
    if (!found) throw new Error(t("seq.noSequence"));
    return { project, sequence: found };
  }

  async function sequenceInfo(sequence: Sequence): Promise<SequenceInfo> {
    const settings = await sequence.getSettings();
    const rate = await settings.getVideoFrameRate();
    const rect = await settings.getVideoFrameRect();
    const inPoint = await sequence.getInPoint();
    const outPoint = await sequence.getOutPoint();
    return {
      name: await sequence.name,
      inSeconds: inPoint.seconds,
      outSeconds: outPoint.seconds,
      fps: formatRational(
        rationalFps(ppro.TickTime.TIME_ONE_SECOND.ticksNumber, rate.ticksPerFrame),
      ),
      fpsValue: rate.value,
      width: rect.width,
      height: rect.height,
      videoTracks: await sequence.getVideoTrackCount(),
      audioTracks: await sequence.getAudioTrackCount(),
    };
  }

  /** The media file behind a clip, or null for a clip without one (title, adjustment layer). */
  async function pathOf(item: Clip): Promise<string | null> {
    try {
      return await ppro.ClipProjectItem.cast(await item.getProjectItem()).getMediaFilePath();
    } catch {
      return null;
    }
  }

  /** The clips on each video track, by 0-based track index. */
  async function videoClips(sequence: Sequence): Promise<Clip[][]> {
    const tracks: Clip[][] = [];
    for (let i = 0; i < (await sequence.getVideoTrackCount()); i++)
      tracks.push(
        (await sequence.getVideoTrack(i)).getTrackItems(
          ppro.Constants.TrackItemType.CLIP,
          false,
        ) as unknown as Clip[],
      );
    return tracks;
  }

  /** The clips of `mediaPath` among `clips` that start at `atS` and last `durationS`, each within a frame. */
  async function captionClips(
    sequence: Sequence,
    clips: Clip[],
    mediaPath: string,
    atS: number,
    durationS: number,
  ): Promise<Clip[]> {
    const frame = 1 / (await (await sequence.getSettings()).getVideoFrameRate()).value;
    const found: Clip[] = [];
    for (const item of clips) {
      const path = await pathOf(item);
      if (!path || !same(path, mediaPath)) continue;
      const start = (await item.getStartTime()).seconds;
      const end = (await item.getEndTime()).seconds;
      if (Math.abs(start - atS) < frame && Math.abs(end - start - durationS) < frame)
        found.push(item);
    }
    return found;
  }

  /** True when the track holds one of our inserts (or its effects) that overlaps [startS, endS]. */
  async function holdsOurInsert(track: Mutable, startS: number, endS: number): Promise<boolean> {
    for (const item of track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)) {
      const start = (await item.getStartTime()).seconds;
      const end = (await item.getEndTime()).seconds;
      if (end <= startS || start >= endS) continue;
      try {
        const path = await ppro.ClipProjectItem.cast(
          await item.getProjectItem(),
        ).getMediaFilePath();
        if (isOurInsert(path)) return true;
      } catch {
        // a clip without a media file (title, adjustment layer) is the editor's own
      }
    }
    return false;
  }

  /**
   * Runs `fn` with the tracks that hold an earlier Kilnframe insert or its sound effects over [startS, endS]
   * switched off, then switches them back on whatever happens. The frames, the picture and the speech of the
   * range must be the editor's own, not what the last run made (9 Oct 2026: a second run over the same range
   * saw only the first run's whiteboard and planned every scene fullscreen). Tracks already off stay off.
   */
  async function withoutOurInserts<T>(
    sequence: Sequence,
    startS: number,
    endS: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    const tracks: Mutable[] = [];
    for (let i = 0; i < (await sequence.getVideoTrackCount()); i++)
      tracks.push((await sequence.getVideoTrack(i)) as unknown as Mutable);
    for (let i = 0; i < (await sequence.getAudioTrackCount()); i++)
      tracks.push((await sequence.getAudioTrack(i)) as unknown as Mutable);
    const hidden: Mutable[] = [];
    try {
      for (const track of tracks) {
        if (await track.isMuted()) continue;
        if ((await holdsOurInsert(track, startS, endS)) && (await track.setMute(true)))
          hidden.push(track);
      }
      return await fn();
    } finally {
      for (const track of hidden) await track.setMute(false);
    }
  }

  /**
   * The range's picture as a small H.264 file, so the preview shows the insert over the real footage. Only
   * the range is encoded: the work area is set to it for the export and put back afterwards, whatever
   * happens. Uses Premiere's own "Match Source, Low bitrate" preset (companion findPreviewPreset).
   */
  async function exportRangePicture(
    sequence: Sequence,
    startS: number,
    endS: number,
    outputPath: string,
    presetPath: string,
  ): Promise<boolean> {
    const area = ppro.WorkAreaUtils;
    const before = {
      in: area.getWorkAreaInPoint(sequence),
      out: area.getWorkAreaOutPoint(sequence),
    };
    try {
      area.setWorkAreaInOutPoints(
        sequence,
        ppro.TickTime.createWithSeconds(startS),
        ppro.TickTime.createWithSeconds(endS),
      );
      return await ppro.EncoderManager.getManager().exportSequence(
        sequence,
        ppro.Constants.ExportType.IMMEDIATELY,
        native(outputPath),
        native(presetPath),
        false,
      );
    } finally {
      area.setWorkAreaInOutPoints(sequence, before.in, before.out);
    }
  }

  async function findOrCreateBin(project: Project, name: string): Promise<ProjectItem> {
    const root = (await project.getRootItem()) as FolderItem;
    const existing = (await root.getItems()).find((i) => i.name === name);
    if (existing) return existing;
    project.lockedAccess(() => {
      project.executeTransaction(
        (compound) => compound.addAction(root.createBinAction(name, false)),
        t("premiere.undoBin"),
      );
    });
    const created = (await root.getItems()).find((i) => i.name === name);
    if (!created) throw new Error(t("premiere.binFailed", { name }));
    return created;
  }

  /** Imports a file into the "Kilnframe" bin and returns its project item. */
  async function importToBin(project: Project, path: string): Promise<ProjectItem> {
    const bin = await findOrCreateBin(project, "Kilnframe");
    const ok = await project.importFiles([native(path)], true, bin, false);
    if (!ok) throw new Error(t("premiere.importFailed", { path }));
    // items from getItems() come back as plain ProjectItems; a bin has to be cast before it can be listed
    const items = await ppro.FolderItem.cast(bin).getItems();
    for (const item of items) {
      const clip = ppro.ClipProjectItem.cast(item as never) as unknown as {
        getMediaFilePath?: () => Promise<string>;
      };
      if (clip.getMediaFilePath && same(await clip.getMediaFilePath(), path)) return item;
    }
    throw new Error(t("premiere.importMissing", { path }));
  }

  /** Overwrites the item at the given time on the given 0-based tracks, as one undoable step. */
  function placeItem(
    project: Project,
    sequence: Sequence,
    item: ProjectItem,
    seconds: number,
    videoTrack: number,
    audioTrack: number,
  ): boolean {
    const editor = ppro.SequenceEditor.getEditor(sequence);
    let ok = false;
    project.lockedAccess(() => {
      ok = project.executeTransaction(
        (compound) =>
          compound.addAction(
            editor.createOverwriteItemAction(
              item,
              ppro.TickTime.createWithSeconds(seconds),
              videoTrack,
              audioTrack,
            ),
          ),
        t("premiere.undoPlace"),
      );
    });
    return ok;
  }

  /**
   * The first track above everything in use: an empty video track just over the highest one holding a clip
   * (so the insert stays on top), and an empty audio track after the last used one. The track count, which
   * makes Premiere add a new track, when there is no empty one there.
   */
  async function freeTracks(sequence: Sequence): Promise<PlaceResult> {
    const CLIP = ppro.Constants.TrackItemType.CLIP;
    const above = async (count: number, used: (i: number) => Promise<boolean>) => {
      let top = -1;
      for (let i = 0; i < count; i++) if (await used(i)) top = i;
      return top + 1;
    };
    const videoTrack = await above(
      await sequence.getVideoTrackCount(),
      async (i) => (await sequence.getVideoTrack(i)).getTrackItems(CLIP, false).length > 0,
    );
    const audioTrack = await above(
      await sequence.getAudioTrackCount(),
      async (i) => (await sequence.getAudioTrack(i)).getTrackItems(CLIP, false).length > 0,
    );
    return { videoTrack, audioTrack };
  }

  /**
   * Imports the delivered insert (and its sound effect mix) and lays them over the range: the clip's in/out
   * cut away the handles, so the editor sees exactly the range and can still trim into the handles. Video goes
   * on a new top video track, sound on a new audio track, each import as one undoable step.
   */
  async function placeInsert(
    project: Project,
    sequence: Sequence,
    files: { video: string; sfx: string | null },
    at: number,
    handlesSeconds: number,
    durationSeconds: number,
    tracks?: PlaceResult,
  ): Promise<PlaceResult> {
    const { videoTrack, audioTrack } = tracks ?? (await freeTracks(sequence));
    const trim = (item: ProjectItem) => {
      const clip = ppro.ClipProjectItem.cast(item);
      project.lockedAccess(() => {
        project.executeTransaction(
          (compound) =>
            compound.addAction(
              clip.createSetInOutPointsAction(
                ppro.TickTime.createWithSeconds(handlesSeconds),
                ppro.TickTime.createWithSeconds(handlesSeconds + durationSeconds),
              ),
            ),
          t("premiere.undoTrim"),
        );
      });
    };
    const video = await importToBin(project, files.video);
    trim(video);
    if (!placeItem(project, sequence, video, at, videoTrack, audioTrack))
      throw new Error(t("premiere.placeFailed"));
    if (files.sfx) {
      const sfx = await importToBin(project, files.sfx);
      trim(sfx);
      if (!placeItem(project, sequence, sfx, at, videoTrack, audioTrack))
        throw new Error(t("premiere.sfxFailed"));
    }
    return { videoTrack, audioTrack };
  }

  /**
   * Story mode: a new sequence with the template sequence's settings (frame size, rate, audio), holding the
   * narration from 0 on A1; it becomes the active sequence so the normal flow animates over it.
   */
  async function createStorySequence(
    project: Project,
    template: Sequence,
    name: string,
    audioPath: string,
    /** The music bed, placed on the second audio track under the narration. */
    musicPath: string | null,
    /** A frame shape for the new sequence; its short side stays the template's. Missing: the template's. */
    format?: "landscape" | "portrait" | "square",
  ): Promise<void> {
    const audio = await importToBin(project, audioPath);
    const sequence = await project.createSequence(name);
    const settings = await template.getSettings();
    if (format) {
      const rect = await settings.getVideoFrameRect();
      const size = frameFor(format, rect.width, rect.height);
      const next = new ppro.RectF();
      next.width = size.width;
      next.height = size.height;
      if (!(await settings.setVideoFrameRect(next))) throw new Error(t("premiere.formatFailed"));
      await settings.setPreviewFrameRect(next);
    }
    project.lockedAccess(() => {
      project.executeTransaction(
        (compound) => compound.addAction(sequence.createSetSettingsAction(settings)),
        t("premiere.undoStory"),
      );
    });
    if (!placeItem(project, sequence, audio, 0, 0, 0)) throw new Error(t("premiere.storyFailed"));
    if (musicPath) {
      const music = await importToBin(project, musicPath);
      if (!placeItem(project, sequence, music, 0, 0, 1)) throw new Error(t("premiere.musicFailed"));
    }
    await project.openSequence(sequence);
    await project.setActiveSequence(sequence);
  }

  return {
    kind: "premiere",
    async currentSequence() {
      const project = await activeProject();
      const sequence = await project.getActiveSequence();
      if (!sequence) throw new Error(t("seq.noSequence"));
      const info = await sequenceInfo(sequence);
      const end = await sequence.getEndTime();
      known.set(sequence.guid.toString(), { project, sequence });
      return {
        id: sequence.guid.toString(),
        name: info.name,
        projectPath: withoutLongPathPrefix(project.path),
        fps: info.fps,
        fpsValue: info.fpsValue,
        width: info.width,
        height: info.height,
        inSeconds: info.inSeconds,
        outSeconds: info.outSeconds,
        endSeconds: end.seconds,
        videoTracks: info.videoTracks,
        audioTracks: info.audioTracks,
      };
    },
    async quickRange() {
      const project = await activeProject();
      const sequence = await project.getActiveSequence();
      if (!sequence) throw new Error(t("seq.noSequence"));
      const [inPoint, outPoint, end] = await Promise.all([
        sequence.getInPoint(),
        sequence.getOutPoint(),
        sequence.getEndTime(),
      ]);
      return {
        id: sequence.guid.toString(),
        inSeconds: inPoint.seconds,
        outSeconds: outPoint.seconds,
        endSeconds: end.seconds,
      };
    },
    async exportFrame(seq, seconds, dir, name, width, height) {
      const { sequence } = await sequenceOf(seq);
      return ppro.Exporter.exportSequenceFrame(
        sequence,
        ppro.TickTime.createWithSeconds(seconds),
        name,
        native(dir),
        width,
        height,
      );
    },
    async exportRangeAudio(seq, _startS, _endS, file, { wavPreset }) {
      // the whole sequence: the companion cuts the range with FFmpeg (the docs do not say whether in/out is used)
      const { sequence } = await sequenceOf(seq);
      const ok = await ppro.EncoderManager.getManager().exportSequence(
        sequence,
        ppro.Constants.ExportType.IMMEDIATELY,
        native(file),
        native(wavPreset),
        true,
      );
      return { ok, offsetSeconds: 0 };
    },
    async exportRangePicture(seq, startS, endS, file, { previewPreset }) {
      const { sequence } = await sequenceOf(seq);
      return exportRangePicture(sequence, startS, endS, file, previewPreset);
    },
    async withoutOurInserts(seq, startS, endS, fn) {
      const { sequence } = await sequenceOf(seq);
      return withoutOurInserts(sequence, startS, endS, fn);
    },
    async placeInsert(seq, files, atS, handlesS, durationS, tracks) {
      const { project, sequence } = await sequenceOf(seq);
      return placeInsert(project, sequence, files, atS, handlesS, durationS, tracks);
    },
    async placeAudioClips(seq, clips) {
      const { project, sequence } = await sequenceOf(seq);
      const { videoTrack, audioTrack } = await freeTracks(sequence);
      // the clips are as long as their sections already: placed whole, no in or out points
      for (const c of clips) {
        const item = await importToBin(project, c.file);
        if (!placeItem(project, sequence, item, c.atS, videoTrack, audioTrack))
          throw new Error(t("premiere.placeFailed"));
      }
      return { audioTrack };
    },
    async ourInsertSpans(seq) {
      const { sequence } = await sequenceOf(seq);
      const spans: { startS: number; endS: number }[] = [];
      for (const clips of await videoClips(sequence))
        for (const item of clips) {
          const path = await pathOf(item);
          if (path && isOurAnimation(path))
            spans.push({
              startS: (await item.getStartTime()).seconds,
              endS: (await item.getEndTime()).seconds,
            });
        }
      return spans.sort((a, b) => a.startS - b.startS);
    },
    async findCaptionClip(seq, mediaPath, atS, durationS) {
      const { sequence } = await sequenceOf(seq);
      const tracks = await videoClips(sequence);
      for (const [i, clips] of tracks.entries())
        if ((await captionClips(sequence, clips, mediaPath, atS, durationS)).length)
          return { videoTrack: i };
      return null;
    },
    // SequenceEditor.createRemoveItemsAction(selection, ripple, mediaType, shiftOverlapping) takes the clips of a
    // TrackItemSelection off; createOverwriteItemAction(item, time, videoTrack, audioTrack) places the new clip.
    // The selection comes from TrackItemSelection.createEmptySelection(callback) and addItem(), and is valid only
    // inside that callback, with nothing asynchronous in it: so the whole transaction runs there, one undo step.
    // developer.adobe.com/premiere-pro/uxp/ppro_reference/classes/sequenceeditor/ and
    // developer.adobe.com/premiere-pro/uxp/ppro_reference/classes/trackitemselection/
    async replaceCaptionClip(seq, oldPath, file, atS, durationS, videoTrack) {
      const { project, sequence } = await sequenceOf(seq);
      const clips = (await videoClips(sequence))[videoTrack] ?? [];
      const old = await captionClips(sequence, clips, oldPath, atS, durationS);
      const item = await importToBin(project, file);
      // a caption clip has no sound; an empty audio track all the same, so nothing lands on the editor's own
      const { audioTrack } = await freeTracks(sequence);
      const editor = ppro.SequenceEditor.getEditor(sequence);
      let ok = false;
      const replace = (selection: TrackItemSelection | null) =>
        project.lockedAccess(() => {
          ok = project.executeTransaction((compound) => {
            if (selection)
              compound.addAction(
                editor.createRemoveItemsAction(
                  selection,
                  false,
                  ppro.Constants.MediaType.ANY,
                  false,
                ),
              );
            compound.addAction(
              editor.createOverwriteItemAction(
                item,
                ppro.TickTime.createWithSeconds(atS),
                videoTrack,
                audioTrack,
              ),
            );
          }, t("premiere.undoPlace"));
        });
      if (!old.length) replace(null);
      else
        ppro.TrackItemSelection.createEmptySelection((selection) => {
          for (const clip of old) selection.addItem(clip as never, true);
          replace(selection);
        });
      if (!ok) throw new Error(t("premiere.placeFailed"));
    },
    async createStorySequence(template, name, narration, music, format) {
      const { project, sequence } = await sequenceOf(template);
      await createStorySequence(project, sequence, name, narration, music, format);
    },
    async pickImages(types) {
      const picked = await uxp.storage.localFileSystem.getFileForOpening({
        allowMultiple: true,
        types,
      });
      const files = !picked ? [] : Array.isArray(picked) ? picked : [picked];
      return files.map((f) => f.nativePath).filter(Boolean);
    },
    async saveTextFile(suggestedName, text) {
      // UXP's own save dialog; the file it returns may be written to without a further permission
      const ext = suggestedName.split(".").pop() ?? "txt";
      const file = await uxp.storage.localFileSystem.getFileForSaving(suggestedName, {
        types: [ext],
      });
      if (!file) return null;
      await file.write(text);
      return file.nativePath;
    },
    async openUrl(url) {
      await uxp.shell.openExternal(url);
    },
    uiLocale: () => uxp.host?.uiLocale ?? null,
    pluginVersion() {
      const v = uxp.versions?.plugin;
      // only a real version string: anything else would break the settings screen
      return typeof v === "string" && /^\d+\.\d+/.test(v) ? v : null;
    },
    readTextFile: (path) => fs.readFile(path, { encoding: "utf-8" }),
    writeTextFile: (path, text) => fs.writeFile(path, text, { encoding: "utf-8" }),
    async fileExists(path) {
      try {
        await fs.lstat(path);
        return true;
      } catch {
        return false;
      }
    },
    homedir() {
      // os.homedir() returns null while a UXP panel is still loading (seen in Premiere 26.5.2)
      const h = os.homedir();
      return h ? h.replace(/\\/g, "/") : null;
    },
    platform: () => (isWin(os) ? "win" : "mac"),
  };
}
