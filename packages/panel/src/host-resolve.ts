// The DaVinci Resolve Studio host: the panel's Host over window.kilnframeResolve (preload.ts), which forwards
// to the bridge in the Electron main process (resolve/bridge.ts) and to a few file and OS calls.
import type { Host, HostSequence } from "./host";
import { t } from "./i18n";
import {
  NO_SEQUENCE,
  PLACE_FAILED,
  RENDER_BUSY,
  RENDER_FAILED,
  type KilnframeResolveApi,
} from "./resolve/api";

/** A project name as a folder name: no path separators or characters Windows refuses. */
const folderName = (name: string) => name.replace(/[\\/:*?"<>|]/g, "-").trim() || "Resolve";

export function createResolveHost(api: KilnframeResolveApi): Host {
  /** The bridge's codes in the panel's words; anything else as it came. */
  const words = async <T>(p: Promise<T>): Promise<T> => {
    try {
      return await p;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      if (m.includes(NO_SEQUENCE)) throw new Error(t("seq.noSequence"), { cause: err });
      if (m.includes(RENDER_BUSY)) throw new Error(t("resolve.renderBusy"), { cause: err });
      if (m.includes(RENDER_FAILED)) throw new Error(t("resolve.renderFailed"), { cause: err });
      if (m.includes(PLACE_FAILED)) throw new Error(t("premiere.placeFailed"), { cause: err });
      throw err;
    }
  };

  return {
    kind: "resolve",
    async currentSequence(): Promise<HostSequence> {
      const s = await words(api.currentSequence());
      return {
        id: s.id,
        name: s.name,
        projectPath: "",
        jobRoot: `${api.homedir()}/Movies/Kilnframe/${folderName(s.projectName)}`,
        fps: s.fps,
        fpsValue: s.fpsValue,
        width: s.width,
        height: s.height,
        inSeconds: s.inSeconds,
        outSeconds: s.outSeconds,
        endSeconds: s.endSeconds,
        videoTracks: s.videoTracks,
        audioTracks: s.audioTracks,
      };
    },
    exportFrame: (seq, seconds, dir, name) =>
      words(api.exportFrame(seq.id, seconds, `${dir.replace(/[\\/]$/, "")}/${name}`)),
    exportRangeAudio: (seq, startS, endS, file) =>
      words(api.exportRangeAudio(seq.id, startS, endS, file)),
    exportRangePicture: (seq, startS, endS, file) =>
      words(api.exportRangePicture(seq.id, startS, endS, file)),
    async withoutOurInserts(seq, startS, endS, fn) {
      const hidden = await words(api.hideOurInserts(seq.id, startS, endS));
      try {
        return await fn();
      } finally {
        await api.showTracks(seq.id, hidden);
      }
    },
    placeInsert: (seq, files, atS, handlesS, durationS, tracks) =>
      words(api.placeInsert(seq.id, files, atS, handlesS, durationS, tracks)),
    createStorySequence: (template, name, narration, music, format) =>
      words(api.createStorySequence(template.id, name, narration, music, format)),
    pickImages: (types) => api.pickImages(types),
    openUrl: (url) => api.openUrl(url),
    uiLocale: () => api.locale(),
    pluginVersion: () => api.pluginVersion(),
    readTextFile: (path) => api.readTextFile(path),
    writeTextFile: (path, text) => api.writeTextFile(path, text),
    fileExists: (path) => api.fileExists(path),
    homedir: () => api.homedir().replace(/\\/g, "/"),
    platform: () => api.platform(),
  };
}
