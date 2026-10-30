// What the Resolve panel's page can ask the Electron main process for (over IPC, through preload.ts). The
// bridge does the Resolve work; the rest are the file and OS calls a sandboxed page cannot make itself.

export interface ResolveSequence {
  /** Timeline.GetUniqueId(). */
  id: string;
  name: string;
  projectName: string;
  /** The panel's fps string ("25", "30000/1001"). */
  fps: string;
  fpsValue: number;
  width: number;
  height: number;
  /** Timeline.GetStartFrame(): 90000 for a 25 fps timeline starting at 01:00:00:00. */
  startFrame: number;
  /** Relative to the timeline start; 0 when no In is set. */
  inSeconds: number;
  /** Relative to the timeline start; the timeline's length when no Out is set. */
  outSeconds: number;
  endSeconds: number;
  videoTracks: number;
  audioTracks: number;
}

export interface HiddenTrack {
  type: "video" | "audio";
  /** 1-based, as Resolve counts tracks. */
  index: number;
}

/** 0-based tracks, as the panel's Host counts them. */
export interface PlacedTracks {
  videoTrack: number;
  audioTrack: number;
}

export interface ResolveBridge {
  currentSequence(): Promise<ResolveSequence>;
  /** True once after an export that could not put the editor's render settings back. */
  renderSettingsLost(): Promise<boolean>;
  /** The current timeline's id, In, Out and length only, for the twice-a-second look. */
  quickRange(): Promise<{ id: string; inSeconds: number; outSeconds: number; endSeconds: number }>;
  /** `offsetSeconds`: where in the timeline the written file starts (the range's start). */
  exportRangeAudio(
    id: string,
    startS: number,
    endS: number,
    file: string,
  ): Promise<{ ok: boolean; offsetSeconds: number }>;
  exportFrame(id: string, seconds: number, file: string): Promise<boolean>;
  exportRangePicture(id: string, startS: number, endS: number, file: string): Promise<boolean>;
  hideOurInserts(id: string, startS: number, endS: number): Promise<HiddenTrack[]>;
  showTracks(id: string, tracks: HiddenTrack[]): Promise<void>;
  placeInsert(
    id: string,
    files: { video: string; sfx: string | null },
    atS: number,
    handlesS: number,
    durationS: number,
    tracks?: PlacedTracks,
  ): Promise<PlacedTracks>;
  /** Ends a wait for Resolve's own render: the export waiting throws EXPORTS_STOPPED. */
  cancelExports(): Promise<void>;
  /** Whether Resolve is rendering (the editor's own queue): the exports wait for it. */
  isRendering(): Promise<boolean>;
  /** Music clips on one new stereo track, each at its time (seconds from the timeline start). */
  placeAudioClips(
    id: string,
    clips: { file: string; atS: number; durationS: number }[],
  ): Promise<{ audioTrack: number }>;
  /** The animation inserts' spans, in seconds from the timeline start. */
  ourInsertSpans(id: string): Promise<{ startS: number; endS: number }[]>;
  /** The 0-based video track of an untouched clip of `mediaPath` at `atS` lasting `durationS`, or null. */
  findCaptionClip(
    id: string,
    mediaPath: string,
    atS: number,
    durationS: number,
  ): Promise<{ videoTrack: number } | null>;
  /**
   * The earlier caption clip, looked up on the 0-based video track where it lay (`old`), replaced by `file` at
   * `atS` for `durationS`; the old one back on failure. False, with nothing changed, when it is not there.
   */
  replaceCaptionClip(
    id: string,
    old: { path: string; atS: number; durationS: number },
    file: string,
    atS: number,
    durationS: number,
    videoTrack: number,
  ): Promise<boolean>;
  createStorySequence(
    templateId: string,
    name: string,
    narration: string,
    music: string | null,
    format?: "landscape" | "portrait" | "square",
  ): Promise<void>;
}

export interface KilnframeResolveApi extends ResolveBridge {
  pickImages(types: string[]): Promise<string[]>;
  /** A caption SRT copied to where the editor picks in a save dialog; null when cancelled. */
  saveFileCopy(source: string, suggestedName: string): Promise<string | null>;
  openUrl(url: string): Promise<void>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, text: string): Promise<void>;
  fileExists(path: string): Promise<boolean>;
  homedir(): string;
  platform(): "mac" | "win";
  locale(): string;
  pluginVersion(): string;
  /** Whether the panel window stays above Resolve, as it opened. */
  onTop(): boolean;
  /** Which editor the window belongs to; absent in an older app, which only hosts Resolve. */
  editor?(): "resolve" | "filmcraft" | undefined;
  setOnTop(on: boolean): Promise<void>;
}

/** Error messages the bridge throws; the host turns them into the panel's words. */
export const NO_SEQUENCE = "NO_SEQUENCE";
export const RENDER_BUSY = "RENDER_BUSY";
export const PLACE_FAILED = "PLACE_FAILED";
export const RENDER_FAILED = "RENDER_FAILED";
export const EXPORTS_STOPPED = "EXPORTS_STOPPED";
/** FilmCraft is not running with its control channel open, or the app no longer has its port and token. */
export const NOT_RUNNING = "FILMCRAFT_NOT_RUNNING";
/** The connection to FilmCraft closed after a request went out: FilmCraft may or may not have done it. */
export const CONNECTION_LOST = "FILMCRAFT_CONNECTION_LOST";
/** FilmCraft did not reply in time. */
export const TIMED_OUT = "FILMCRAFT_TIMED_OUT";
