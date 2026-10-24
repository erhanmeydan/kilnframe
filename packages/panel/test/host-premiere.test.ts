import { describe, expect, it, vi } from "vitest";
import { createPremiereHost } from "../src/host-premiere";
import { HOST_MEMBERS } from "./host-members";

const TICKS_PER_SECOND = 254016000000;

/** A clip on a track of the fake's first sequence, in sequence seconds. */
interface FakeClip {
  path: string;
  start: number;
  end: number;
}

/**
 * A Premiere with one project, sequences that can be switched and removed, a bin and a sequence editor. The first
 * sequence's tracks hold `video` and `audio` clips; the editor's actions change them when the transaction runs:
 * an overwrite cuts away what lies under the new clip, a remove takes the selected clips off.
 */
function fakePremiere(opts: { win?: boolean; video?: FakeClip[][]; audio?: FakeClip[][] } = {}) {
  const seqs = new Map<string, ReturnType<typeof makeSeq>>();
  const overwrites: { path: string; at: number; videoTrack: number; audioTrack: number }[] = [];
  const binItems: { name: string; path: string }[] = [];
  /** A file's length in seconds once imported; 10 when the test does not say. */
  const lengths = new Map<string, number>();
  const video: FakeClip[][] = opts.video ?? [[], []];
  const audio: FakeClip[][] = opts.audio ?? [[], []];
  const tick = (s: number) => ({ seconds: s, ticks: String(s * TICKS_PER_SECOND) });
  const trackItem = (c: FakeClip) => ({
    raw: c,
    getStartTime: async () => tick(c.start),
    getEndTime: async () => tick(c.end),
    getProjectItem: async () => ({ path: c.path }),
  });
  const trackApi = (clips: FakeClip[]) => ({
    isMuted: async () => false,
    setMute: async () => true,
    getTrackItems: () => clips.map(trackItem),
  });
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
      getVideoTrackCount: async () => video.length,
      getAudioTrackCount: async () => audio.length,
      getVideoTrack: async (i: number) => trackApi(video[i] ?? []),
      getAudioTrack: async (i: number) => trackApi(audio[i] ?? []),
      createSetSettingsAction: () => ({}),
    };
  }
  let active = makeSeq("guid-1", "Main");
  seqs.set("guid-1", active);
  /** The sequence whose tracks the fake keeps; edits to the others are only logged. */
  const first = active;
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
    executeTransaction: (fn: (c: { addAction(a: { apply?: () => void }): boolean }) => void) => {
      fn({
        addAction: (a) => {
          a.apply?.();
          return true;
        },
      });
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
    Constants: {
      TrackItemType: { CLIP: 1 },
      ExportType: { IMMEDIATELY: 0 },
      MediaType: { ANY: 0, DATA: 1, VIDEO: 2, AUDIO: 3 },
    },
    TrackItemSelection: {
      createEmptySelection: (cb: (s: { items: { raw: FakeClip }[] }) => void) => {
        const items: { raw: FakeClip }[] = [];
        cb({
          items,
          addItem: (it: { raw: FakeClip }) => (items.push(it), true),
        } as never);
        return true;
      },
    },
    ClipProjectItem: {
      cast: (item: { path?: string }) => ({
        getMediaFilePath: async () => item.path,
        createSetInOutPointsAction: () => ({}),
      }),
    },
    FolderItem: { cast: (item: unknown) => item },
    SequenceEditor: {
      getEditor: (sequence: unknown) => ({
        createOverwriteItemAction: (
          item: { path: string },
          at: { seconds: number },
          videoTrack: number,
          audioTrack: number,
        ) => {
          overwrites.push({ path: item.path, at: at.seconds, videoTrack, audioTrack });
          return {
            apply() {
              const track = sequence === first ? video[videoTrack] : undefined;
              if (!track) return;
              const start = at.seconds;
              const end = start + (lengths.get(item.path) ?? 10);
              // what lay under the new clip is cut away, as an overwrite edit does
              const kept = track.flatMap((c) =>
                c.end <= start || c.start >= end
                  ? [c]
                  : [
                      ...(c.start < start ? [{ ...c, end: start }] : []),
                      ...(c.end > end ? [{ ...c, start: end }] : []),
                    ],
              );
              track.splice(0, track.length, ...kept, { path: item.path, start, end });
            },
          };
        },
        createRemoveItemsAction: (selection: { items: { raw: FakeClip }[] }) => ({
          apply() {
            for (const track of [...video, ...audio])
              for (const it of selection.items) {
                const i = track.indexOf(it.raw);
                if (i >= 0) track.splice(i, 1);
              }
          },
        }),
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
    storage: {
      localFileSystem: {
        getFileForOpening: vi.fn(async () => null),
        getFileForSaving: vi.fn(
          async (): Promise<{ nativePath: string; write: (d: string) => Promise<void> } | null> =>
            null,
        ),
      },
    },
  };
  const fs = {
    readFile: vi.fn(async () => "{}"),
    writeFile: vi.fn(async () => undefined),
    lstat: vi.fn(async () => ({})),
  };
  let home: string | null = null;
  const os = { homedir: () => home, platform: () => (opts.win ? "win32" : "darwin") };
  const make = () => createPremiereHost(ppro as never, uxp as never, fs as never, os as never);
  return {
    ppro,
    uxp,
    fs,
    os,
    project,
    overwrites,
    video,
    lengths,
    make,
    setHome: (h: string) => (home = h),
  };
}

describe("premiere host", () => {
  it("saves a text file where the editor picks in UXP's save dialog", async () => {
    const f = fakePremiere();
    const written: string[] = [];
    f.uxp.storage.localFileSystem.getFileForSaving.mockImplementationOnce(async () => ({
      nativePath: "/Users/me/Talk.srt",
      write: async (d: string) => void written.push(d),
    }));
    const h = f.make();
    expect(await h.saveTextFile!("Talk.srt", "1\n")).toBe("/Users/me/Talk.srt");
    expect(f.uxp.storage.localFileSystem.getFileForSaving).toHaveBeenCalledWith("Talk.srt", {
      types: ["srt"],
    });
    expect(written).toEqual(["1\n"]);
    // cancelled
    expect(await h.saveTextFile!("Talk.srt", "1\n")).toBeNull();
  });

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

  const insert = "/Edits/Kilnframe/Main-20261024/insert.mov";
  const captions = "/Edits/Kilnframe/Main-Captions-20261024/captions-1.mov";
  const footage = { path: "/Footage/interview.mov", start: 0, end: 30 };

  it("lists only the animation inserts' spans, not music, sound effects or captions", async () => {
    const f = fakePremiere({
      video: [
        [footage],
        [{ path: insert, start: 2, end: 7 }],
        [{ path: captions, start: 0, end: 30 }],
      ],
      audio: [
        [footage],
        [{ path: "/Edits/Kilnframe/Main-Music-20261024/music/s1.wav", start: 0, end: 20 }],
        [{ path: "/Edits/Kilnframe/Main-20261024/sfx_mix.wav", start: 2, end: 7 }],
      ],
    });
    const h = f.make();
    expect(await h.ourInsertSpans(await h.currentSequence())).toEqual([{ startS: 2, endS: 7 }]);
  });

  it("finds an untouched caption clip, and not one that was trimmed", async () => {
    const f = fakePremiere({ video: [[footage], [{ path: captions, start: 2, end: 12 }]] });
    const h = f.make();
    const seq = await h.currentSequence();
    expect(await h.findCaptionClip(seq, captions, 2, 10)).toEqual({ videoTrack: 1 });
    expect(await h.findCaptionClip(seq, "/Edits/Kilnframe/x/captions-2.mov", 2, 10)).toBeNull();
    f.video[1]![0]!.end = 11;
    expect(await h.findCaptionClip(seq, captions, 2, 10)).toBeNull();
  });

  it("replaces the caption clip in place: one clip on its track, at its start, with the new file", async () => {
    const f = fakePremiere({ video: [[footage], [{ path: captions, start: 2, end: 12 }]] });
    const next = "/Edits/Kilnframe/Main-Captions-20261024/captions-2.mov";
    // a frame shorter than the old clip: an overwrite alone would leave a sliver of it behind
    f.lengths.set(next, 10 - 1 / 25);
    const h = f.make();
    const seq = await h.currentSequence();
    await h.replaceCaptionClip(seq, captions, next, 2, 10, 1);
    expect(f.video[1]).toEqual([{ path: next, start: 2, end: 12 - 1 / 25 }]);
    expect(f.video[0]).toEqual([footage]);
  });
});
