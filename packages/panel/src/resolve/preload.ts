// The page's only door to the main process (contextIsolation and sandbox are on): one invoke per call, and the
// few values the host needs synchronously, read once.
import { contextBridge, ipcRenderer } from "electron";

const ASYNC = [
  "currentSequence",
  "quickRange",
  "renderSettingsLost",
  "exportRangeAudio",
  "exportFrame",
  "exportRangePicture",
  "hideOurInserts",
  "showTracks",
  "placeInsert",
  "placeAudioClips",
  "createStorySequence",
  "ourInsertSpans",
  "findCaptionClip",
  "replaceCaptionClip",
  "isRendering",
  "cancelExports",
  "pickImages",
  "openUrl",
  "readTextFile",
  "writeTextFile",
  "fileExists",
  "setOnTop",
] as const;

const info = ipcRenderer.sendSync("kilnframe:info") as {
  homedir: string;
  platform: "mac" | "win";
  locale: string;
  pluginVersion: string;
  onTop: boolean;
};

contextBridge.exposeInMainWorld("kilnframeResolve", {
  ...Object.fromEntries(
    ASYNC.map((m) => [m, (...args: unknown[]) => ipcRenderer.invoke(`kilnframe:${m}`, ...args)]),
  ),
  homedir: () => info.homedir,
  platform: () => info.platform,
  locale: () => info.locale,
  pluginVersion: () => info.pluginVersion,
  onTop: () => info.onTop,
});
