import type { QuickRange } from "./range-watch";
// What the panel needs from the editor it runs in. app.ts talks only to host(); the entry installs one
// (index.ts: Premiere Pro). Everything editor-specific lives behind this interface.

export interface HostSequence {
  /** Premiere: sequence.guid; Resolve: timeline.GetUniqueId(). Keys the per-sequence settings (style, story narration). */
  id: string;
  name: string;
  /** Where the companion makes the job folders: next to the project file. */
  projectPath: string;
  /** A folder for the job folders when there is no project file (Resolve): ~/Movies/Kilnframe/<project>. */
  jobRoot?: string;
  fps: string;
  fpsValue: number;
  width: number;
  height: number;
  inSeconds: number;
  outSeconds: number;
  endSeconds: number;
  videoTracks: number;
  audioTracks: number;
}

/** 0-based tracks an insert was placed on. */
export interface PlaceResult {
  videoTrack: number;
  audioTrack: number;
  /**
   * The clip, rendered at 4K for a larger sequence, could not be scaled up to fill it: the percent the editor
   * sets by hand (Scale to Frame Size does the same).
   */
  scaleByHand?: number;
}

/** A stretch to take out of a sequence, in sequence seconds. */
export interface TimelineCut {
  startS: number;
  endS: number;
}

/** The sequence a cut made: it is open and active, the original untouched. */
export interface CutSequenceResult {
  id: string;
  name: string;
  /** Clips that could not be carried into the new sequence (no media file, retimed...). */
  leftOut: number;
  /** Built from source clips: effects, grades and titles are not on it. */
  rebuilt: boolean;
}

export interface Host {
  kind: "premiere" | "resolve" | "filmcraft";
  /** The active sequence; throws a readable message when there is no project or sequence. */
  currentSequence(): Promise<HostSequence>;
  /** Resolve: true once after an export that could not put the editor's Deliver settings back. */
  renderSettingsLost?(): Promise<boolean>;
  /** The active sequence's id, in and out points and length only, quick enough to ask twice a second. */
  quickRange?(): Promise<QuickRange>;
  exportFrame(
    seq: HostSequence,
    seconds: number,
    dir: string,
    name: string,
    width: number,
    height: number,
  ): Promise<boolean>;
  /** `offsetSeconds`: where in the sequence the written file starts (a whole-sequence export: 0). */
  exportRangeAudio(
    seq: HostSequence,
    startS: number,
    endS: number,
    file: string,
    opts: { wavPreset: string },
  ): Promise<{ ok: boolean; offsetSeconds: number }>;
  exportRangePicture(
    seq: HostSequence,
    startS: number,
    endS: number,
    file: string,
    opts: { previewPreset: string },
  ): Promise<boolean>;
  /** The panel's own window (Resolve): whether it stays above the editor. */
  onTop?: { get(): boolean; set(on: boolean): void };
  /** The editor stopped the job: ends any wait the exports are in (Resolve: for its own render). */
  cancelExports?(): void;
  /** A note for the editor before the exports start, when they will wait (Resolve: its own render queue). */
  busyNote?(): Promise<string | null>;
  /** Runs `fn` with earlier Kilnframe inserts over the range switched off, then switches them back on. */
  withoutOurInserts<T>(
    seq: HostSequence,
    startS: number,
    endS: number,
    fn: () => Promise<T>,
  ): Promise<T>;
  /**
   * 0-based audio tracks with a clip over [startS, endS) that is not one of Kilnframe's own (inserts, sound
   * effects, music): where the editor's speech can be.
   */
  speechTracksAt(seq: HostSequence, startS: number, endS: number): Promise<number[]>;
  /**
   * Runs `fn` with every other audio track switched off, so an export hears the 0-based `track` alone, then
   * switches them back on, also when `fn` throws. `isolated` is false when the editor could not switch the
   * tracks and `fn` ran with everything playing.
   */
  withOnlyAudioTrack<T>(
    seq: HostSequence,
    track: number,
    fn: () => Promise<T>,
  ): Promise<{ result: T; isolated: boolean }>;
  placeInsert(
    seq: HostSequence,
    files: { video: string; sfx: string | null },
    atS: number,
    handlesS: number,
    durationS: number,
    /** The tracks of an earlier part of the same long range; a new pair of tracks when missing. */
    tracks?: PlaceResult,
  ): Promise<PlaceResult>;
  /** Music clips on one new audio track, each at its time in the sequence (seconds). */
  placeAudioClips(
    seq: HostSequence,
    clips: { file: string; atS: number; durationS: number }[],
  ): Promise<{ audioTrack: number }>;
  /** Where the animation inserts (insert.mov, insert.mp4) lie, in sequence seconds; music, effects and captions not. */
  ourInsertSpans(seq: HostSequence): Promise<{ startS: number; endS: number }[]>;
  /**
   * The video track (0-based) of a clip of `mediaPath` that starts at `atS` and lasts `durationS`, each within a
   * frame: an earlier caption clip the editor left untouched. Null when there is none.
   */
  findCaptionClip(
    seq: HostSequence,
    mediaPath: string,
    atS: number,
    durationS: number,
  ): Promise<{ videoTrack: number } | null>;
  /**
   * Takes the earlier caption clip off the 0-based video track, looked up where it lay (`old`: its file, start
   * and length), and places `file` on that track at `atS` for `durationS`. False, with nothing changed, when the
   * earlier clip is no longer there as it was; the caller then places the new clip on a new track.
   */
  replaceCaptionClip(
    seq: HostSequence,
    old: { path: string; atS: number; durationS: number },
    file: string,
    atS: number,
    durationS: number,
    videoTrack: number,
  ): Promise<boolean>;
  /** A new sequence holding the narration (and music); it becomes the active sequence. */
  createStorySequence(
    template: HostSequence,
    name: string,
    narration: string,
    music: string | null,
    format?: "landscape" | "portrait" | "square",
  ): Promise<void>;
  /**
   * A new sequence, `name`, holding `seq` with `cuts` taken out of every track, which becomes the active one;
   * `seq` itself is not edited. Missing where the editor cannot cut: the tab says it is not available here.
   */
  cutToNewSequence?(
    seq: HostSequence,
    cuts: TimelineCut[],
    name: string,
    onProgress?: (done: number, total: number) => void,
  ): Promise<CutSequenceResult>;
  pickImages(types: string[]): Promise<string[]>;
  /**
   * A copy of the text file `source` (one the companion wrote, a caption job's SRT) where the editor picks in
   * the host's save dialog: the path it was saved to, or null when the editor cancelled.
   */
  saveFileCopy(source: string, suggestedName: string): Promise<string | null>;
  openUrl(url: string): Promise<void>;
  /** The editor's interface language ("tr_TR"), or null when it does not say. */
  uiLocale(): string | null;
  /** The installed panel's version, or null when the host does not know it. */
  pluginVersion(): string | null;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, text: string): Promise<void>;
  fileExists(path: string): Promise<boolean>;
  /** The home folder with "/" separators, or null while it is not known yet. */
  homedir(): string | null;
  platform(): "mac" | "win";
}

let current: Host | null = null;

export function setHost(h: Host): void {
  current = h;
}

export function host(): Host {
  if (!current)
    throw new Error("No host installed: the entry must call setHost() before the panel starts.");
  return current;
}
