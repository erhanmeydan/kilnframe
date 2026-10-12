import { describe, expect, it, vi } from "vitest";
import { setLang } from "../src/i18n";
import { createResolveHost } from "../src/host-resolve";
import type { KilnframeResolveApi, ResolveSequence } from "../src/resolve/api";
import { HOST_MEMBERS } from "./host-members";

const seq: ResolveSequence = {
  id: "tl-1",
  name: "Timeline 1",
  projectName: "Belgesel: Ay / Gelgit",
  fps: "25",
  fpsValue: 25,
  width: 1920,
  height: 1080,
  startFrame: 90000,
  inSeconds: 2,
  outSeconds: 9.04,
  endSeconds: 10.84,
  videoTracks: 1,
  audioTracks: 1,
};

function fakeApi(over: Partial<KilnframeResolveApi> = {}): KilnframeResolveApi {
  return {
    currentSequence: vi.fn(async () => seq),
    exportRangeAudio: vi.fn(async () => ({ ok: true, offsetSeconds: 2 })),
    exportFrame: vi.fn(async () => true),
    exportRangePicture: vi.fn(async () => true),
    hideOurInserts: vi.fn(async () => [{ type: "video" as const, index: 2 }]),
    showTracks: vi.fn(async () => undefined),
    placeInsert: vi.fn(async () => ({ videoTrack: 1, audioTrack: 1 })),
    createStorySequence: vi.fn(async () => undefined),
    isRendering: vi.fn(async () => false),
    pickImages: vi.fn(async () => []),
    openUrl: vi.fn(async () => undefined),
    readTextFile: vi.fn(async () => ""),
    writeTextFile: vi.fn(async () => undefined),
    fileExists: vi.fn(async () => true),
    homedir: () => "/Users/e",
    platform: () => "mac",
    locale: () => "tr-TR",
    pluginVersion: () => "0.2.0",
    ...over,
  };
}

describe("resolve host", () => {
  it("implements every member of Host", () => {
    const h = createResolveHost(fakeApi());
    for (const m of HOST_MEMBERS)
      expect(typeof (h as unknown as Record<string, unknown>)[m]).toBe("function");
    expect(h.kind).toBe("resolve");
  });

  it("maps the timeline and puts its job folders under ~/Movies/Kilnframe/<project>", async () => {
    const s = await createResolveHost(fakeApi()).currentSequence();
    expect(s).toMatchObject({
      id: "tl-1",
      name: "Timeline 1",
      projectPath: "",
      jobRoot: "/Users/e/Movies/Kilnframe/Belgesel- Ay - Gelgit",
      fps: "25",
      inSeconds: 2,
      outSeconds: 9.04,
      endSeconds: 10.84,
    });
  });

  it("turns the bridge's codes into the panel's words", async () => {
    setLang("en");
    const busy = fakeApi({
      exportRangeAudio: vi.fn(async () => {
        throw new Error("RENDER_BUSY");
      }),
      currentSequence: vi.fn(async () => {
        throw new Error("NO_SEQUENCE");
      }),
    });
    const h = createResolveHost(busy);
    await expect(h.currentSequence()).rejects.toThrow(/sequence/i);
    await expect(
      h.exportRangeAudio({ ...seq, projectPath: "" } as never, 0, 1, "/a.wav", { wavPreset: "" }),
    ).rejects.toThrow(/still rendering after 10 minutes/);
  });

  it("says before the exports that it waits for a render Resolve is doing", async () => {
    setLang("en");
    const idle = createResolveHost(fakeApi());
    expect(await idle.busyNote?.()).toBeNull();
    const busy = createResolveHost(fakeApi({ isRendering: vi.fn(async () => true) }));
    expect(await busy.busyNote?.()).toMatch(/waits for it/);
  });

  it("switches our earlier inserts back on even when the export fails", async () => {
    const api = fakeApi();
    const h = createResolveHost(api);
    const s = await h.currentSequence();
    await expect(
      h.withoutOurInserts(s, 0, 5, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(api.showTracks).toHaveBeenCalledWith("tl-1", [{ type: "video", index: 2 }]);
  });

  it("passes the range and the job's file to the bridge, and reports the audio's offset", async () => {
    const api = fakeApi();
    const h = createResolveHost(api);
    const s = await h.currentSequence();
    expect(await h.exportRangeAudio(s, 2, 9.04, "/j/sequence.wav", { wavPreset: "" })).toEqual({
      ok: true,
      offsetSeconds: 2,
    });
    expect(api.exportRangeAudio).toHaveBeenCalledWith("tl-1", 2, 9.04, "/j/sequence.wav");
    await h.exportFrame(s, 3, "/j/", "footage-1.png", 1920, 1080);
    expect(api.exportFrame).toHaveBeenCalledWith("tl-1", 3, "/j/footage-1.png");
  });
});
