// The panel window and the calls its page makes, shared by every Electron host of the Resolve panel page:
// Resolve's own Electron (resolve/main.ts) and the Kilnframe app (for FilmCraft). The host brings the bridge to
// its editor; this file brings the window, its remembered size and place, and the file and OS calls a
// sandboxed page cannot make.
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath, sep } from "node:path";
import { kilnframeFile, saveCopy } from "../resolve/paths";
import { CUT_UNSUPPORTED, type ResolveBridge } from "../resolve/api";

export type Editor = "resolve" | "filmcraft";

export interface PanelWindowOptions {
  editor: Editor;
  title: string;
  bridge: () => Promise<ResolveBridge>;
  /** Resolve quits its own Electron; the Kilnframe app keeps running. */
  onClosed: () => void;
}

const home = homedir();
/** Files the page may ask about (a story narration in a job folder): anywhere in the home folder. */
function insideHome(path: string): string {
  const full = resolvePath(path);
  if (!full.startsWith(home + sep)) throw new Error(`Not inside the home folder: ${path}`);
  return full;
}

function pluginVersion(dir: string): string {
  try {
    return (
      /<Version>([^<]+)<\/Version>/.exec(readFileSync(join(dir, "manifest.xml"), "utf8"))?.[1] ?? ""
    );
  } catch {
    return "";
  }
}

const BRIDGE_CALLS = [
  "currentSequence",
  "quickRange",
  "renderSettingsLost",
  "exportRangeAudio",
  "exportFrame",
  "exportRangePicture",
  "hideOurInserts",
  "showTracks",
  "speechTracks",
  "soloAudioTrack",
  "placeInsert",
  "placeAudioClips",
  "createStorySequence",
  "ourInsertSpans",
  "findCaptionClip",
  "replaceCaptionClip",
  "isRendering",
  "cancelExports",
  "cutToNewTimeline",
  "cutProgress",
] as const;

// window size, place and always-on-top, kept between sessions
const windowFile = () => join(app.getPath("userData"), "kilnframe-window.json");
interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  onTop: boolean;
}
/** The panel's width when it first opens; the tab bar holds every tab on one line from here. */
export const PANEL_WIDTH = 440;
export const PANEL_MIN_WIDTH = 360;

/**
 * The saved size, widened once to the new width: a window saved before the panel grew more tabs was 380 wide,
 * and its tab names broke over two lines. `sized: 2` marks a size kept since, which stays as the editor left it.
 */
export function windowStateFrom(saved: Partial<WindowState> & { sized?: number }): WindowState {
  const s = { width: PANEL_WIDTH, height: 760, onTop: true, ...saved };
  if (saved.sized !== 2) s.width = Math.max(s.width, PANEL_WIDTH);
  return { ...s, width: Math.max(s.width, PANEL_MIN_WIDTH) };
}

function readWindowState(): WindowState {
  try {
    return windowStateFrom(JSON.parse(readFileSync(windowFile(), "utf8")));
  } catch {
    return windowStateFrom({});
  }
}

interface Current {
  o: PanelWindowOptions;
  dir: string;
  win: () => BrowserWindow | null;
}
// The Kilnframe app reopens the window in one long-running process, and ipcMain allows a channel only once:
// the handlers are registered once and read whichever window and options are current.
let current: Current | null = null;
let registered = false;

/** The window to talk to, or null when there is none or it is gone. */
function liveWindow(): BrowserWindow | null {
  const w = current?.win() ?? null;
  return w && !w.isDestroyed() ? w : null;
}

function currentOptions(): PanelWindowOptions {
  if (!current) throw new Error("The Kilnframe panel is not open.");
  return current.o;
}

export function registerPanelIpc(
  o: PanelWindowOptions,
  dir: string,
  win: () => BrowserWindow | null,
): void {
  current = { o, dir, win };
  if (registered) return;
  registered = true;
  ipcMain.on("kilnframe:info", (e) => {
    e.returnValue = {
      homedir: home,
      platform: process.platform === "win32" ? "win" : "mac",
      locale: app.getLocale(),
      pluginVersion: current ? pluginVersion(current.dir) : "",
      onTop: liveWindow()?.isAlwaysOnTop() ?? readWindowState().onTop,
      editor: current?.o.editor,
    };
  });
  for (const m of BRIDGE_CALLS)
    ipcMain.handle(`kilnframe:${m}`, async (_e, ...args: unknown[]) => {
      const b = await currentOptions().bridge();
      const call = b[m] as ((...a: unknown[]) => Promise<unknown>) | undefined;
      // the cut is optional on a bridge: one without it says so in a code the host can read
      if (!call) {
        if (m === "cutProgress") return null;
        throw new Error(CUT_UNSUPPORTED);
      }
      return call.apply(b, args);
    });
  ipcMain.handle("kilnframe:setOnTop", (_e, on: boolean) => {
    liveWindow()?.setAlwaysOnTop(Boolean(on));
  });
  ipcMain.handle("kilnframe:pickImages", async (_e, types: string[]) => {
    const w = liveWindow();
    if (!w) return [];
    const r = await dialog.showOpenDialog(w, {
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Images", extensions: types }],
    });
    return r.canceled ? [] : r.filePaths;
  });
  // the caption SRT the companion wrote, copied to where the editor picks (the job folder is outside ~/.kilnframe)
  ipcMain.handle("kilnframe:saveFileCopy", (_e, source: string, suggestedName: string) =>
    saveCopy(source, suggestedName, home, async (name) => {
      const w = liveWindow();
      if (!w) return null;
      const r = await dialog.showSaveDialog(w, {
        defaultPath: join(app.getPath("documents"), name),
        filters: [{ name: "SubRip", extensions: ["srt"] }],
      });
      return r.canceled || !r.filePath ? null : r.filePath;
    }),
  );
  ipcMain.handle("kilnframe:openUrl", async (_e, url: string) => {
    if (!/^(https|kilnframe):/i.test(url)) throw new Error(`Not opened: ${url}`);
    await shell.openExternal(url);
  });
  ipcMain.handle("kilnframe:readTextFile", (_e, path: string) =>
    readFile(kilnframeFile(path, home), "utf8"),
  );
  ipcMain.handle("kilnframe:writeTextFile", async (_e, path: string, text: string) => {
    const full = kilnframeFile(path, home);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, text, "utf8");
  });
  ipcMain.handle("kilnframe:fileExists", async (_e, path: string) => {
    try {
      await access(insideHome(path));
      return true;
    } catch {
      return false;
    }
  });
}

/** Opens the panel window from `dir` (index.html, preload.js, icons/, manifest.xml) and answers its calls. */
export function openPanelWindow(o: PanelWindowOptions, dir: string): BrowserWindow {
  const s = readWindowState();
  const win = new BrowserWindow({
    ...(s.x !== undefined && s.y !== undefined ? { x: s.x, y: s.y } : {}),
    width: s.width,
    height: s.height,
    minWidth: PANEL_MIN_WIDTH,
    minHeight: 480,
    title: o.title,
    // Windows shows it on the taskbar
    icon: join(dir, "icons", "app.png"),
    backgroundColor: "#1e1f22",
    alwaysOnTop: s.onTop,
    webPreferences: {
      preload: join(dir, "preload.js"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  registerPanelIpc(o, dir, () => win);
  win.setMenu(null);
  // the page is the panel and nothing else: no navigating away with the preload attached, no new windows
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.on("close", () => {
    try {
      const b = win.getBounds();
      writeFileSync(windowFile(), JSON.stringify({ ...b, onTop: win.isAlwaysOnTop(), sized: 2 }));
    } catch {
      // the window state is a convenience
    }
    o.onClosed();
  });
  win.on("closed", () => {
    if (current?.win() === win) current = null;
  });
  void win.loadFile(join(dir, "index.html"));
  return win;
}
