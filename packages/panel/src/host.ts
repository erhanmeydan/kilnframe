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
}

export interface Host {
  kind: "premiere" | "resolve";
  /** The active sequence; throws a readable message when there is no project or sequence. */
  currentSequence(): Promise<HostSequence>;
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
  /** A new sequence holding the narration (and music); it becomes the active sequence. */
  createStorySequence(
    template: HostSequence,
    name: string,
    narration: string,
    music: string | null,
    format?: "landscape" | "portrait" | "square",
  ): Promise<void>;
  pickImages(types: string[]): Promise<string[]>;
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
