// The Kilnframe panel inside DaVinci Resolve Studio: Resolve starts this file in its own Electron when the user
// opens Workspace > Workflow Integrations > Kilnframe. It opens the panel window and answers the page's calls:
// the Resolve work through the bridge (WorkflowIntegration.node, copied beside this file by the Kilnframe app
// from the user's own Resolve install), and the file and OS calls a sandboxed page cannot make.
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath, sep } from "node:path";
import { createResolveBridge } from "./bridge";
import { untilItWorks } from "./once";
import { kilnframeFile } from "./paths";
import type { ResolveBridge } from "./api";

const PLUGIN_ID = "com.kilnframe.resolve";

interface WorkflowIntegrationModule {
  InitializePromise(id: string): Promise<boolean>;
  GetResolvePromise(): Promise<unknown>;
  CleanUp(): void;
}
const WorkflowIntegration = require("./WorkflowIntegration.node") as WorkflowIntegrationModule;

const resolveBridge = untilItWorks(async (): Promise<ResolveBridge> => {
  if (!(await WorkflowIntegration.InitializePromise(PLUGIN_ID)))
    throw new Error(
      "DaVinci Resolve did not accept the plugin (WorkflowIntegration.InitializePromise).",
    );
  return createResolveBridge(await WorkflowIntegration.GetResolvePromise());
});

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
      const b = await resolveBridge();
      return (b[m] as (...a: unknown[]) => Promise<unknown>)(...args);
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
    title: "Kilnframe",
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
    WorkflowIntegration.CleanUp();
    app.quit();
  });
  void win.loadFile(join(__dirname, "index.html"));
}

app.whenReady().then(() => {
  register();
  createWindow();
});
