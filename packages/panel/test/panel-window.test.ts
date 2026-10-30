import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as PanelModule from "../src/electron/panel-window";
type PanelWindowOptions = PanelModule.PanelWindowOptions;

type Handler = (...a: unknown[]) => unknown;
const { listeners, handlers, windows } = vi.hoisted(() => ({
  listeners: new Map<string, (...a: unknown[]) => unknown>(),
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
  windows: [] as Array<{ emit: (ev: string) => void; destroyed: boolean }>,
}));
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/kilnframe-no-such-dir", getLocale: () => "en-US" },
  BrowserWindow: class {
    destroyed = false;
    private on_ = new Map<string, Array<() => void>>();
    webContents = { on: () => {}, setWindowOpenHandler: () => {} };
    constructor() {
      windows.push(this);
    }
    setMenu() {}
    loadFile() {
      return Promise.resolve();
    }
    on(ev: string, f: () => void) {
      this.on_.set(ev, [...(this.on_.get(ev) ?? []), f]);
    }
    emit(ev: string) {
      if (ev === "closed") this.destroyed = true;
      for (const f of this.on_.get(ev) ?? []) f();
    }
    getBounds() {
      return {};
    }
    isAlwaysOnTop() {
      return true;
    }
    isDestroyed() {
      return this.destroyed;
    }
    setAlwaysOnTop() {}
  },
  dialog: {},
  ipcMain: {
    on: (ch: string, f: Handler) => {
      listeners.set(ch, f);
    },
    handle: (ch: string, f: Handler) => {
      // like Electron: a channel may be handled once
      if (handlers.has(ch)) throw new Error(`Attempted to register a second handler for '${ch}'`);
      handlers.set(ch, f);
    },
  },
  shell: {},
}));

const CALLS = [
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
];

function options(over: Partial<PanelWindowOptions> = {}): PanelWindowOptions {
  return {
    editor: "filmcraft",
    title: "Kilnframe",
    bridge: async () => ({ currentSequence: async (x: number) => x + 1 }) as never,
    onClosed: () => {},
    ...over,
  };
}

function info() {
  const e: { returnValue?: { editor: string; pluginVersion: string } } = {};
  listeners.get("kilnframe:info")!(e);
  return e.returnValue!;
}

let panel: typeof PanelModule;
beforeEach(async () => {
  listeners.clear();
  handlers.clear();
  windows.length = 0;
  vi.resetModules();
  panel = await import("../src/electron/panel-window");
});

describe("registerPanelIpc", () => {
  it("registers every bridge call and the file and window calls", () => {
    panel.registerPanelIpc(options(), "/x", () => null);
    for (const m of CALLS) expect(handlers.has(`kilnframe:${m}`), m).toBe(true);
    for (const m of [
      "setOnTop",
      "pickImages",
      "saveFileCopy",
      "openUrl",
      "readTextFile",
      "writeTextFile",
      "fileExists",
    ])
      expect(handlers.has(`kilnframe:${m}`), m).toBe(true);
  });

  it("passes calls to the bridge and its errors through unchanged", async () => {
    panel.registerPanelIpc(options(), "/x", () => null);
    expect(await handlers.get("kilnframe:currentSequence")!({}, 1)).toBe(2);
    const boom = new Error("boom");
    panel.registerPanelIpc(options({ bridge: () => Promise.reject(boom) }), "/x", () => null);
    await expect(handlers.get("kilnframe:currentSequence")!({})).rejects.toBe(boom);
  });

  it("tells the page which editor it runs in and the version in <dir>/manifest.xml", () => {
    const dir = mkdtempSync(join(tmpdir(), "kf-panel-"));
    writeFileSync(join(dir, "manifest.xml"), "<Plugin><Version>9.8.7</Version></Plugin>");
    panel.registerPanelIpc(options({ editor: "filmcraft" }), dir, () => null);
    expect(info()).toMatchObject({ editor: "filmcraft", pluginVersion: "9.8.7" });
  });

  it("can be registered twice: the second options and bridge are the ones used", async () => {
    panel.registerPanelIpc(options({ editor: "resolve" }), "/a", () => null);
    expect(() =>
      panel.registerPanelIpc(
        options({
          editor: "filmcraft",
          bridge: async () => ({ currentSequence: async () => "second" }) as never,
        }),
        "/b",
        () => null,
      ),
    ).not.toThrow();
    expect(info().editor).toBe("filmcraft");
    expect(await handlers.get("kilnframe:currentSequence")!({})).toBe("second");
  });
});

describe("openPanelWindow", () => {
  it("can be opened again after it closed, with the new options", async () => {
    const onClosed = vi.fn();
    panel.openPanelWindow(options({ editor: "resolve", onClosed }), "/a");
    expect(info().editor).toBe("resolve");
    windows[0].emit("close");
    windows[0].emit("closed");
    expect(onClosed).toHaveBeenCalledTimes(1);
    // closed: nothing to talk to
    await expect(handlers.get("kilnframe:currentSequence")!({})).rejects.toThrow(/not open/);
    expect(await handlers.get("kilnframe:pickImages")!({}, ["png"])).toEqual([]);

    expect(() => panel.openPanelWindow(options({ editor: "filmcraft" }), "/b")).not.toThrow();
    expect(info().editor).toBe("filmcraft");
    expect(await handlers.get("kilnframe:currentSequence")!({}, 4)).toBe(5);
  });

  it("does not forget the new window when the old one closes late", () => {
    panel.openPanelWindow(options({ editor: "resolve" }), "/a");
    panel.openPanelWindow(options({ editor: "filmcraft" }), "/b");
    windows[0].emit("closed");
    expect(info().editor).toBe("filmcraft");
  });
});
