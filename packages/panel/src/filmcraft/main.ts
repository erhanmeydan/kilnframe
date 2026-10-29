// The Kilnframe panel for FilmCraft: its own Electron window, the same page as the DaVinci Resolve panel, with
// the editor work done over FilmCraft's control channel (../filmcraft/bridge.ts) instead of Resolve's scripting.
// The Kilnframe FilmCraft launcher starts FilmCraft with the control channel open and then this app.
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath, sep } from "node:path";
import { createFilmCraftBridge } from "../filmcraft/bridge";
import { createFilmCraftClient, NOT_RUNNING } from "../filmcraft/client";
import { kilnframeFile, saveCopy } from "../resolve/paths";

const client = createFilmCraftClient();
const bridge = createFilmCraftBridge(client);

/** Shown in the panel when FilmCraft is closed or was opened without the launcher. */
const notRunningText = () =>
  /^tr/i.test(app.getLocale())
    ? "FilmCraft Kilnframe için açık değil. FilmCraft'ı Dock'tan değil, \"FilmCraft + Kilnframe\" uygulamasıyla aç."
    : 'FilmCraft is not open for Kilnframe. Open FilmCraft with the "FilmCraft + Kilnframe" app, not from the Dock.';

const home = homedir();
/** Files the page may ask about (a story narration in a job folder): anywhere in the home folder. */
function insideHome(path: string): string {
  const full = resolvePath(path);
  if (!full.startsWith(home + sep)) throw new Error(`Not inside the home folder: ${path}`);
  return full;
}

function pluginVersion(): string {
  try {
    return (
      /<Version>([^<]+)<\/Version>/.exec(
        readFileSync(join(__dirname, "manifest.xml"), "utf8"),
      )?.[1] ?? ""
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
  "placeInsert",
  "placeAudioClips",
  "createStorySequence",
  "ourInsertSpans",
  "findCaptionClip",
  "replaceCaptionClip",
  "isRendering",
  "cancelExports",
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
function readWindowState(): WindowState {
  try {
    return {
      width: 380,
      height: 760,
      onTop: true,
      ...JSON.parse(readFileSync(windowFile(), "utf8")),
    };
  } catch {
    return { width: 380, height: 760, onTop: true };
  }
}

let win: BrowserWindow | null = null;

function register() {
  ipcMain.on("kilnframe:info", (e) => {
    e.returnValue = {
      homedir: home,
      platform: process.platform === "win32" ? "win" : "mac",
      locale: app.getLocale(),
      pluginVersion: pluginVersion(),
      onTop: win?.isAlwaysOnTop() ?? readWindowState().onTop,
    };
  });
  for (const m of BRIDGE_CALLS)
    ipcMain.handle(`kilnframe:${m}`, async (_e, ...args: unknown[]) => {
      try {
        return await (bridge[m] as (...a: unknown[]) => Promise<unknown>)(...args);
      } catch (err) {
        if (err instanceof Error && err.message === NOT_RUNNING)
          throw new Error(notRunningText(), { cause: err });
        throw err;
      }
    });
  ipcMain.handle("kilnframe:setOnTop", (_e, on: boolean) => {
    win?.setAlwaysOnTop(Boolean(on));
  });
  ipcMain.handle("kilnframe:pickImages", async (_e, types: string[]) => {
    const r = await dialog.showOpenDialog(win!, {
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Images", extensions: types }],
    });
    return r.canceled ? [] : r.filePaths;
  });
  // the caption SRT the companion wrote, copied to where the editor picks (the job folder is outside ~/.kilnframe)
  ipcMain.handle("kilnframe:saveFileCopy", (_e, source: string, suggestedName: string) =>
    saveCopy(source, suggestedName, home, async (name) => {
      const r = await dialog.showSaveDialog(win!, {
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

function createWindow() {
  const s = readWindowState();
  win = new BrowserWindow({
    ...(s.x !== undefined && s.y !== undefined ? { x: s.x, y: s.y } : {}),
    width: s.width,
    height: s.height,
    minWidth: 320,
    minHeight: 480,
    title: "Kilnframe for FilmCraft",
    // Windows shows it on the taskbar
    icon: join(__dirname, "icons", "app.png"),
    backgroundColor: "#1e1f22",
    alwaysOnTop: s.onTop,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.setMenu(null);
  // the page is the panel and nothing else: no navigating away with the preload attached, no new windows
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.on("close", () => {
    try {
      const b = win!.getBounds();
      writeFileSync(windowFile(), JSON.stringify({ ...b, onTop: win!.isAlwaysOnTop() }));
    } catch {
      // the window state is a convenience
    }
    client.close();
    app.quit();
  });
  void win.loadFile(join(__dirname, "index.html"));
}

app.whenReady().then(() => {
  app.dock?.setIcon(join(__dirname, "icons", "app.png"));
  register();
  createWindow();
});
