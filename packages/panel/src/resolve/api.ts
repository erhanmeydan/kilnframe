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
  openUrl(url: string): Promise<void>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, text: string): Promise<void>;
  fileExists(path: string): Promise<boolean>;
  homedir(): string;
  platform(): "mac" | "win";
  locale(): string;
  pluginVersion(): string;
}

/** Error messages the bridge throws; the host turns them into the panel's words. */
export const NO_SEQUENCE = "NO_SEQUENCE";
export const RENDER_BUSY = "RENDER_BUSY";
export const PLACE_FAILED = "PLACE_FAILED";
export const RENDER_FAILED = "RENDER_FAILED";
