import { describe, expect, it, vi } from "vitest";
import { createPremiereHost } from "../src/host-premiere";
import { HOST_MEMBERS } from "./host-members";

const TICKS_PER_SECOND = 254016000000;

/** A Premiere with one project, sequences that can be switched and removed, a bin and a sequence editor. */
function fakePremiere(opts: { win?: boolean } = {}) {
  const seqs = new Map<string, ReturnType<typeof makeSeq>>();
  const overwrites: { path: string; at: number; videoTrack: number; audioTrack: number }[] = [];
  const binItems: { name: string; path: string }[] = [];
  const tick = (s: number) => ({ seconds: s, ticks: String(s * TICKS_PER_SECOND) });
  function makeSeq(guid: string, name: string) {
    return {
      guid: { toString: () => guid },
      name,
      getSettings: async () => ({
        getVideoFrameRate: async () => ({ ticksPerFrame: TICKS_PER_SECOND / 25, value: 25 }),
        getVideoFrameRect: async () => ({ width: 1920, height: 1080 }),
        getVideoPixelAspectRatio: async () => "1",
        setVideoFrameRect: async () => true,
        setPreviewFrameRect: async () => true,
      }),
      getInPoint: async () => tick(2),
      getOutPoint: async () => tick(9),
      getEndTime: async () => tick(30),
      getTimebase: async () => String(TICKS_PER_SECOND / 25),
      getVideoTrackCount: async () => 2,
      getAudioTrackCount: async () => 2,
      getVideoTrack: async () => ({ getTrackItems: () => [] }),
      getAudioTrack: async () => ({ getTrackItems: () => [] }),
      createSetSettingsAction: () => ({}),
    };
  }
  let active = makeSeq("guid-1", "Main");
  seqs.set("guid-1", active);
  const bin = { name: "Kilnframe", getItems: async () => binItems };
  const root = {
    getItems: async () => [bin],
    createBinAction: () => ({}),
  };
  const project = {
    path: opts.win ? "\\\\?\\C:\\Edits\\film.prproj" : "/Edits/film.prproj",
    getActiveSequence: async () => active,
    getSequences: async () => [...seqs.values()],
    getRootItem: async () => root,
    importFiles: async (paths: string[]) => {
      for (const p of paths) binItems.push({ name: p.split(/[\\/]/).pop() as string, path: p });
      return true;
    },
    lockedAccess: (fn: () => void) => fn(),
    executeTransaction: (fn: (c: { addAction(a: unknown): boolean }) => void) => {
      fn({ addAction: () => true });
      return true;
    },
    createSequence: async (name: string) => {
      const s = makeSeq(`guid-${seqs.size + 1}`, name);
      seqs.set(s.guid.toString(), s);
      return s;
    },
    openSequence: async () => true,
    setActiveSequence: async (s: ReturnType<typeof makeSeq>) => {
      active = s;
      return true;
    },
    activate(guid: string, name: string) {
      active = makeSeq(guid, name);
      seqs.set(guid, active);
    },
    remove: (guid: string) => seqs.delete(guid),
  };
  const ppro = {
    Project: { getActiveProject: async () => project },
    TickTime: {
      TIME_ONE_SECOND: { ticksNumber: TICKS_PER_SECOND },
      createWithSeconds: (s: number) => ({ seconds: s }),
    },
    WorkAreaUtils: {
      getWorkAreaInPoint: () => ({ seconds: 0 }),
      getWorkAreaOutPoint: () => ({ seconds: 30 }),
    },
    Exporter: { exportSequenceFrame: vi.fn(async () => true) },
    Constants: { TrackItemType: { CLIP: 1 }, ExportType: { IMMEDIATELY: 0 } },
    ClipProjectItem: {
      cast: (item: { path?: string }) => ({
        getMediaFilePath: async () => item.path,
        createSetInOutPointsAction: () => ({}),
      }),
    },
    FolderItem: { cast: (item: unknown) => item },
    SequenceEditor: {
      getEditor: () => ({
        createOverwriteItemAction: (
          item: { path: string },
          at: { seconds: number },
          videoTrack: number,
          audioTrack: number,
        ) => {
          overwrites.push({ path: item.path, at: at.seconds, videoTrack, audioTrack });
          return {};
        },
      }),
    },
    RectF: class {
      width = 0;
      height = 0;
    },
  };
  const uxp = {
    host: { uiLocale: "tr_TR" },
    versions: { plugin: "0.1.2" },
    shell: { openExternal: vi.fn(async () => undefined) },
    storage: { localFileSystem: { getFileForOpening: vi.fn(async () => null) } },
  };
  const fs = {
    readFile: vi.fn(async () => "{}"),
    writeFile: vi.fn(async () => undefined),
    lstat: vi.fn(async () => ({})),
  };
  let home: string | null = null;
  const os = { homedir: () => home, platform: () => (opts.win ? "win32" : "darwin") };
  const make = () => createPremiereHost(ppro as never, uxp as never, fs as never, os as never);
  return { ppro, uxp, fs, os, project, overwrites, make, setHome: (h: string) => (home = h) };
}

describe("premiere host", () => {
  it("implements every member of Host", () => {
    const h = fakePremiere().make();
    for (const m of HOST_MEMBERS)
      expect(typeof (h as unknown as Record<string, unknown>)[m]).toBe("function");
    expect(h.kind).toBe("premiere");
  });

  it("maps the active sequence to a HostSequence", async () => {
    const seq = await fakePremiere().make().currentSequence();
    expect(seq).toEqual({
      id: "guid-1",
      name: "Main",
      projectPath: "/Edits/film.prproj",
      fps: "25",
      fpsValue: 25,
      width: 1920,
      height: 1080,
      inSeconds: 2,
      outSeconds: 9,
      endSeconds: 30,
      videoTracks: 2,
      audioTracks: 2,
    });
  });

  it("strips the Windows long-path prefix from the project path", async () => {
    const seq = await fakePremiere({ win: true }).make().currentSequence();
    expect(seq.projectPath).toBe("C:\\Edits\\film.prproj");
  });

  it("finds the sequence again by id after another one became active (story mode, review screen)", async () => {
    const f = fakePremiere();
    const h = f.make();
    const first = await h.currentSequence();
    f.project.activate("guid-9", "Story");
    expect((await h.currentSequence()).id).toBe("guid-9");
    await h.exportFrame(first, 3, "/jobs/a/", "footage-1.png", 1920, 1080);
    const call = f.ppro.Exporter.exportSequenceFrame.mock.calls[0] as unknown as unknown[];
    expect((call[0] as { name: string }).name).toBe("Main");
  });

  it("keeps working on the job's project after the user switched to another open project", async () => {
    const a = fakePremiere();
    const b = fakePremiere();
    b.project.activate("guid-b", "Other project's sequence");
    b.project.remove("guid-1");
    let activeProject: unknown = a.project;
    a.ppro.Project.getActiveProject = async () => activeProject as typeof a.project;
    const h = a.make();
    const seq = await h.currentSequence();
    activeProject = b.project;
    await h.exportFrame(seq, 3, "/jobs/a/", "footage-1.png", 1920, 1080);
    const call = a.ppro.Exporter.exportSequenceFrame.mock.calls[0] as unknown as unknown[];
    expect((call[0] as { name: string }).name).toBe("Main");
  });

  it("fails with the no-sequence message when the sequence is gone", async () => {
    const f = fakePremiere();
    const h = f.make();
    const first = await h.currentSequence();
    f.project.activate("guid-9", "Other");
    f.project.remove("guid-1");
    await expect(h.exportFrame(first, 3, "/jobs/a/", "x.png", 10, 10)).rejects.toThrow();
  });

  it("hands Premiere native Windows paths", async () => {
    const f = fakePremiere({ win: true });
    f.setHome("C:/Users/e");
    const h = f.make();
    const seq = await h.currentSequence();
    await h.exportFrame(seq, 3, "C:/Users/e/jobs/a/", "f.png", 10, 10);
    const call = f.ppro.Exporter.exportSequenceFrame.mock.calls[0] as unknown as unknown[];
    expect(call[3]).toBe("C:\\Users\\e\\jobs\\a\\");
  });

  it("reports the platform, locale and plugin version from UXP", () => {
    const h = fakePremiere({ win: true }).make();
    expect(h.platform()).toBe("win");
    expect(h.uiLocale()).toBe("tr_TR");
    expect(h.pluginVersion()).toBe("0.1.2");
  });

  it("reuses the first part's tracks for the later parts of a long range", async () => {
    const f = fakePremiere();
    const h = f.make();
    const seq = await h.currentSequence();
    const first = await h.placeInsert(seq, { video: "/j/1/insert.mov", sfx: null }, 2, 0.8, 5);
    await h.placeInsert(seq, { video: "/j/2/insert.mov", sfx: null }, 7, 0.8, 5, first);
    const [a, b] = f.overwrites;
    expect([b?.videoTrack, b?.audioTrack]).toEqual([a?.videoTrack, a?.audioTrack]);
    expect(b?.at).toBe(7);
  });

  it("makes the story sequence the active one, so the next read returns its id", async () => {
    const f = fakePremiere();
    const h = f.make();
    const before = await h.currentSequence();
    await h.createStorySequence(before, "Story: Moon", "/j/s/narration.wav", null);
    const after = await h.currentSequence();
    expect(after.id).not.toBe(before.id);
    expect(after.name).toBe("Story: Moon");
    expect(f.overwrites[0]).toMatchObject({ path: "/j/s/narration.wav", at: 0, audioTrack: 0 });
  });
});
