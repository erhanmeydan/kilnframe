// Thin wrappers over the Premiere UXP API (@adobe/premierepro 26.5). Every call here is written from the
// official type definitions; the probe panel exists to confirm the behaviour inside Premiere.
import { frameFor } from "./frame";
import { nativePath, samePath, withoutLongPathPrefix } from "./home";
import { t } from "./i18n";
import type { FolderItem, Project, ProjectItem, Sequence, premierepro } from "@adobe/premierepro";
import { formatRational, rationalFps } from "./fps";
import { isOurInsert } from "./our-files";

const ppro = require("premierepro") as premierepro;

export interface SequenceInfo {
  name: string;
  inSeconds: number;
  outSeconds: number;
  inTicks: string;
  outTicks: string;
  workAreaIn: number | null;
  workAreaOut: number | null;
  fps: string;
  fpsValue: number;
  width: number;
  height: number;
  pixelAspect: string;
  timebase: string;
  videoTracks: number;
  audioTracks: number;
}

export async function activeSequence(): Promise<{ project: Project; sequence: Sequence }> {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error(t("seq.noProject"));
  const sequence = await project.getActiveSequence();
  if (!sequence) throw new Error(t("seq.noSequence"));
  return { project, sequence };
}

export async function sequenceInfo(sequence: Sequence): Promise<SequenceInfo> {
  const settings = await sequence.getSettings();
  const rate = await settings.getVideoFrameRate();
  const rect = await settings.getVideoFrameRect();
  const inPoint = await sequence.getInPoint();
  const outPoint = await sequence.getOutPoint();
  let workAreaIn: number | null = null;
  let workAreaOut: number | null = null;
  try {
    workAreaIn = ppro.WorkAreaUtils.getWorkAreaInPoint(sequence).seconds;
    workAreaOut = ppro.WorkAreaUtils.getWorkAreaOutPoint(sequence).seconds;
  } catch {
    // WorkAreaUtils' minimum version is unverified; report null instead of failing the probe
  }
  return {
    name: await sequence.name,
    inSeconds: inPoint.seconds,
    outSeconds: outPoint.seconds,
    inTicks: inPoint.ticks,
    outTicks: outPoint.ticks,
    workAreaIn,
    workAreaOut,
    fps: formatRational(rationalFps(ppro.TickTime.TIME_ONE_SECOND.ticksNumber, rate.ticksPerFrame)),
    fpsValue: rate.value,
    width: rect.width,
    height: rect.height,
    pixelAspect: await settings.getVideoPixelAspectRatio(),
    timebase: await sequence.getTimebase(),
    videoTracks: await sequence.getVideoTrackCount(),
    audioTracks: await sequence.getAudioTrackCount(),
  };
}

/** Exports one frame of the sequence as PNG. */
export async function exportFrame(
  sequence: Sequence,
  seconds: number,
  dir: string,
  name: string,
  width: number,
  height: number,
) {
  return ppro.Exporter.exportSequenceFrame(
    sequence,
    ppro.TickTime.createWithSeconds(seconds),
    name,
    nativePath(dir),
    width,
    height,
  );
}

/**
 * Exports the sequence with a WAV preset. `full` = whole sequence; otherwise the work area (the docs do not
 * say whether in/out is used). The companion cuts the in/out range with FFmpeg, so `full` is the safe default.
 */
export async function exportSequenceAudio(
  sequence: Sequence,
  outputPath: string,
  presetPath: string,
  full = true,
) {
  const manager = ppro.EncoderManager.getManager();
  return manager.exportSequence(
    sequence,
    ppro.Constants.ExportType.IMMEDIATELY,
    nativePath(outputPath),
    nativePath(presetPath),
    full,
  );
}

/** A track that can be switched off for an export (video and audio tracks both can). */
interface Mutable {
  isMuted(): Promise<boolean>;
  setMute(mute: boolean): Promise<boolean>;
  getTrackItems(
    type: number,
    includeEmpty: boolean,
  ): {
    getStartTime(): Promise<{ seconds: number }>;
    getEndTime(): Promise<{ seconds: number }>;
    getProjectItem(): Promise<ProjectItem>;
  }[];
}

/** True when the track holds one of our inserts (or its effects) that overlaps [startS, endS]. */
async function holdsOurInsert(track: Mutable, startS: number, endS: number): Promise<boolean> {
  for (const item of track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)) {
    const start = (await item.getStartTime()).seconds;
    const end = (await item.getEndTime()).seconds;
    if (end <= startS || start >= endS) continue;
    try {
      const path = await ppro.ClipProjectItem.cast(await item.getProjectItem()).getMediaFilePath();
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
export async function withoutOurInserts<T>(
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
export async function exportRangePicture(
  sequence: Sequence,
  startS: number,
  endS: number,
  outputPath: string,
  presetPath: string,
): Promise<boolean> {
  const area = ppro.WorkAreaUtils;
  const before = { in: area.getWorkAreaInPoint(sequence), out: area.getWorkAreaOutPoint(sequence) };
  try {
    area.setWorkAreaInOutPoints(
      sequence,
      ppro.TickTime.createWithSeconds(startS),
      ppro.TickTime.createWithSeconds(endS),
    );
    return await ppro.EncoderManager.getManager().exportSequence(
      sequence,
      ppro.Constants.ExportType.IMMEDIATELY,
      nativePath(outputPath),
      nativePath(presetPath),
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
export async function importToBin(project: Project, path: string): Promise<ProjectItem> {
  const bin = await findOrCreateBin(project, "Kilnframe");
  const ok = await project.importFiles([nativePath(path)], true, bin, false);
  if (!ok) throw new Error(t("premiere.importFailed", { path }));
  // items from getItems() come back as plain ProjectItems; a bin has to be cast before it can be listed
  const items = await ppro.FolderItem.cast(bin).getItems();
  for (const item of items) {
    const clip = ppro.ClipProjectItem.cast(item as never) as unknown as {
      getMediaFilePath?: () => Promise<string>;
    };
    if (clip.getMediaFilePath && samePath(await clip.getMediaFilePath(), path)) return item;
  }
  throw new Error(t("premiere.importMissing", { path }));
}

/** Overwrites the item at the given time on the given 0-based tracks, as one undoable step. */
export function placeItem(
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

/** What the main panel needs about the active sequence. */
export interface PanelSequence {
  project: Project;
  sequence: Sequence;
  projectPath: string;
  guid: string;
  info: SequenceInfo;
  endSeconds: number;
}

export async function panelSequence(): Promise<PanelSequence> {
  const { project, sequence } = await activeSequence();
  const info = await sequenceInfo(sequence);
  const end = await sequence.getEndTime();
  return {
    project,
    sequence,
    projectPath: withoutLongPathPrefix(project.path),
    guid: sequence.guid.toString(),
    info,
    endSeconds: end.seconds,
  };
}

/**
 * Imports the delivered insert (and its sound effect mix) and lays them over the range: the clip's in/out
 * cut away the handles, so the editor sees exactly the range and can still trim into the handles. Video goes
 * on a new top video track, sound on a new audio track, each import as one undoable step.
 */
/**
 * The first track above everything in use: an empty video track just over the highest one holding a clip
 * (so the insert stays on top), and an empty audio track after the last used one. The track count, which
 * makes Premiere add a new track, when there is no empty one there.
 */
export async function freeTracks(
  sequence: Sequence,
): Promise<{ videoTrack: number; audioTrack: number }> {
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

export async function placeInsert(
  target: PanelSequence,
  files: { video: string; sfx: string | null },
  at: number,
  handlesSeconds: number,
  durationSeconds: number,
  /** The tracks of an earlier part of the same long range; a new pair of tracks when missing. */
  tracks?: { videoTrack: number; audioTrack: number },
): Promise<{ videoTrack: number; audioTrack: number }> {
  const { project, sequence } = target;
  const free = tracks ?? (await freeTracks(sequence));
  const { videoTrack, audioTrack } = free;
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
 * Story mode: a new sequence with the active sequence's settings (frame size, rate, audio), holding the
 * narration from 0 on A1; it becomes the active sequence so the normal flow animates over it.
 */
export async function createStorySequence(
  template: PanelSequence,
  name: string,
  audioPath: string,
  /** The music bed, placed on the second audio track under the narration. */
  musicPath: string | null = null,
  /** A frame shape for the new sequence; its short side stays the template's. Missing: the template's. */
  format?: "landscape" | "portrait" | "square",
): Promise<Sequence> {
  const { project } = template;
  const audio = await importToBin(project, audioPath);
  const sequence = await project.createSequence(name);
  const settings = await template.sequence.getSettings();
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
  return sequence;
}
