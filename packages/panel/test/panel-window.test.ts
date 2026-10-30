import { beforeEach, describe, expect, it, vi } from "vitest";

const { on, handle } = vi.hoisted(() => ({ on: vi.fn(), handle: vi.fn() }));
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp", getLocale: () => "en-US" },
  BrowserWindow: class {},
  dialog: {},
  ipcMain: { on, handle },
  shell: {},
}));

import { registerPanelIpc, type PanelWindowOptions } from "../src/electron/panel-window";

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

describe("registerPanelIpc", () => {
  beforeEach(() => {
    on.mockClear();
    handle.mockClear();
  });

  it("registers every bridge call and the file and window calls", () => {
    registerPanelIpc(options(), () => null);
    const names = handle.mock.calls.map((c) => c[0]);
    for (const m of CALLS) expect(names).toContain(`kilnframe:${m}`);
    for (const m of [
      "setOnTop",
      "pickImages",
      "saveFileCopy",
      "openUrl",
      "readTextFile",
      "writeTextFile",
      "fileExists",
    ])
      expect(names).toContain(`kilnframe:${m}`);
  });

  it("passes calls to the bridge and its errors through unchanged", async () => {
    const boom = new Error("boom");
    registerPanelIpc(options(), () => null);
    const call = handle.mock.calls.find((c) => c[0] === "kilnframe:currentSequence")![1];
    expect(await call({}, 1)).toBe(2);
    handle.mockClear();
    registerPanelIpc(options({ bridge: async () => Promise.reject(boom) }), () => null);
    const failing = handle.mock.calls.find((c) => c[0] === "kilnframe:currentSequence")![1];
    await expect(failing({})).rejects.toBe(boom);
  });

  it("tells the page which editor it runs in", () => {
    registerPanelIpc(options({ editor: "filmcraft" }), () => null);
    const info = on.mock.calls.find((c) => c[0] === "kilnframe:info")![1];
    const e: { returnValue?: { editor: string } } = {};
    info(e);
    expect(e.returnValue?.editor).toBe("filmcraft");
  });
});
