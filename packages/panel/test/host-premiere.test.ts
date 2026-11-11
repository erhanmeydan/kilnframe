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
function fakePremiere(
  opts: {
    win?: boolean;
    video?: FakeClip[][];
    audio?: FakeClip[][];
    /** The sequences' frame; 1920x1080 when missing. */
    size?: { width: number; height: number };
    /** Clips without a Motion effect, so their Scale cannot be set. */
    noMotion?: boolean;
  } = {},
) {
  const seqs = new Map<string, ReturnType<typeof makeSeq>>();
  /** Motion > Scale values set on clips, by clip file. */
  const scales: { path: string; value: number }[] = [];
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
    // Premiere's chain: Opacity, then Motion, whose param 1 is Scale
    getComponentChain: async () => {
      const motion = {
        getMatchName: async () => "AE.ADBE Motion",
        getParam: (i: number) => ({
          displayName: i === 1 ? "Scale" : "Position",
          createKeyframe: (value: number) => ({ value }),
          createSetValueAction: (k: { value: number }) => ({
            apply: () => scales.push({ path: c.path, value: k.value }),
          }),
        }),
      };
      const opacity = { getMatchName: async () => "AE.ADBE Opacity", getParam: motion.getParam };
      const list = opts.noMotion ? [opacity] : [opacity, motion];
      return { getComponentCount: () => list.length, getComponentAtIndex: (i: number) => list[i] };
    },
  });
  /** Which tracks are muted, by their clip list; a track not in it is on. */
  const muted = new Map<FakeClip[], boolean>();
  /** Decides a setMute call before it lands: false refuses it, a throw fails it. */
  const muteRule = { fn: (_clips: FakeClip[], _mute: boolean): boolean | void => undefined };
  const trackApi = (clips: FakeClip[]) => ({
    isMuted: async () => muted.get(clips) ?? false,
    setMute: async (mute: boolean) => {
      // the rule may refuse (false) or throw, as Premiere can
      if (muteRule.fn(clips, mute) === false) return false;
      muted.set(clips, mute);
      return true;
    },
    getTrackItems: () => clips.map(trackItem),
  });
  function makeSeq(guid: string, name: string) {
    return {
      guid: { toString: () => guid },
      name,
      getSettings: async () => ({
        getVideoFrameRate: async () => ({ ticksPerFrame: TICKS_PER_SECOND / 25, value: 25 }),
        getVideoFrameRect: async () => opts.size ?? { width: 1920, height: 1080 },
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
  const files = new Map<string, string>();
  const fs = {
    readFile: vi.fn(async (path: string) => files.get(path) ?? "{}"),
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
    scales,
    video,
    audio,
    muted,
    muteRule,
    lengths,
    files,
    make,
    setHome: (h: string) => (home = h),
  };
}

describe("premiere host", () => {
  it("copies a file where the editor picks in UXP's save dialog", async () => {
    const f = fakePremiere();
    const written: string[] = [];
    f.uxp.storage.localFileSystem.getFileForSaving.mockImplementationOnce(async () => ({
      nativePath: "/Users/me/Talk.srt",
      write: async (d: string) => void written.push(d),
    }));
    f.files.set("/j/cap/captions-1.srt", "1\n");
    const h = f.make();
    expect(await h.saveFileCopy("/j/cap/captions-1.srt", "Talk.srt")).toBe("/Users/me/Talk.srt");
    expect(f.uxp.storage.localFileSystem.getFileForSaving).toHaveBeenCalledWith("Talk.srt", {
      types: ["srt"],
    });
    expect(written).toEqual(["1\n"]);
    // cancelled
    expect(await h.saveFileCopy("/j/cap/captions-1.srt", "Talk.srt")).toBeNull();
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

  it("places a part on the sequence's frame grid, not between frames", async () => {
    const f = fakePremiere();
    const h = f.make();
    const seq = await h.currentSequence();
    // a sentence end rounded to milliseconds: 7.123 s is frame 178.075 at 25 fps
    await h.placeInsert(seq, { video: "/j/2/insert.mov", sfx: null }, 7.123, 0.8, 5);
    expect(f.overwrites[0]?.at).toBeCloseTo(178 / 25, 9);
  });

  it("scales a 4K insert up to fill an 8K sequence, and not one on a 4K sequence", async () => {
    const big = fakePremiere({ size: { width: 7680, height: 4320 } });
    const h = big.make();
    const placed = await h.placeInsert(
      await h.currentSequence(),
      { video: "/j/1/insert.mov", sfx: null },
      2,
      0.8,
      5,
    );
    expect(placed.scaleByHand).toBeUndefined();
    expect(big.scales).toEqual([{ path: "/j/1/insert.mov", value: 200 }]);

    const uhd = fakePremiere({ size: { width: 3840, height: 2160 } });
    const u = uhd.make();
    await u.placeInsert(
      await u.currentSequence(),
      { video: "/j/1/insert.mov", sfx: null },
      2,
      0.8,
      5,
    );
    expect(uhd.scales).toEqual([]);
  });

  it("places the insert and says the percent to set by hand when its Scale cannot be found", async () => {
    const f = fakePremiere({ size: { width: 6144, height: 3240 }, noMotion: true });
    const h = f.make();
    const placed = await h.placeInsert(
      await h.currentSequence(),
      { video: "/j/1/insert.mov", sfx: null },
      2,
      0.8,
      5,
    );
    expect(placed.scaleByHand).toBe(150);
    expect(f.overwrites).toHaveLength(1);
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
    const old = { path: captions, atS: 2, durationS: 10 };
    expect(await h.replaceCaptionClip(seq, old, next, 2, 10, 1)).toBe(true);
    expect(f.video[1]).toEqual([{ path: next, start: 2, end: 12 - 1 / 25 }]);
    expect(f.video[0]).toEqual([footage]);
  });

  it("takes the old clip off where it lay and places the new one at another range", async () => {
    const f = fakePremiere({ video: [[footage], [{ path: captions, start: 0, end: 30 }]] });
    const next = "/Edits/Kilnframe/Main-Captions-20261024/captions-2.mov";
    f.lengths.set(next, 10);
    const h = f.make();
    const seq = await h.currentSequence();
    const old = { path: captions, atS: 0, durationS: 30 };
    expect(await h.replaceCaptionClip(seq, old, next, 5, 10, 1)).toBe(true);
    expect(f.video[1]).toEqual([{ path: next, start: 5, end: 15 }]);
  });

  it("changes nothing when the old clip is no longer where it lay", async () => {
    const f = fakePremiere({ video: [[footage], [{ path: captions, start: 0, end: 30 }]] });
    const next = "/Edits/Kilnframe/Main-Captions-20261024/captions-2.mov";
    f.lengths.set(next, 10);
    const h = f.make();
    const seq = await h.currentSequence();
    // looked up by the new range's numbers, as before the fix: not found
    const old = { path: captions, atS: 5, durationS: 10 };
    expect(await h.replaceCaptionClip(seq, old, next, 5, 10, 1)).toBe(false);
    expect(f.video[1]).toEqual([{ path: captions, start: 0, end: 30 }]);
  });
  describe("speech track", () => {
    const music = "/Edits/Kilnframe/Main-Music-20261024/music/s1.wav";
    const lav = { path: "/Footage/lav.wav", start: 0, end: 30 };
    const later = { path: "/Footage/room.wav", start: 12, end: 30 };
    const audio = () => [[footage], [lav], [{ path: music, start: 0, end: 20 }], [later]];

    it("finds the audio tracks with the editor's own clips under the range, not ours or empty ones", async () => {
      const f = fakePremiere({ audio: audio() });
      const h = f.make();
      expect(await h.speechTracksAt(await h.currentSequence(), 2, 9)).toEqual([0, 1]);
    });

    it("mutes every other audio track for the export and puts them back, leaving a muted one muted", async () => {
      const f = fakePremiere({ audio: audio() });
      f.muted.set(f.audio[3]!, true);
      const h = f.make();
      const seq = await h.currentSequence();
      let during: boolean[] = [];
      const out = await h.withOnlyAudioTrack(seq, 1, async () => {
        during = f.audio.map((t) => f.muted.get(t) ?? false);
        return "wav";
      });
      expect(out).toEqual({ result: "wav", isolated: true });
      expect(during).toEqual([true, false, true, true]);
      expect(f.audio.map((t) => f.muted.get(t) ?? false)).toEqual([false, false, false, true]);
    });

    it("puts the tracks back when the export throws", async () => {
      const f = fakePremiere({ audio: audio() });
      const h = f.make();
      const seq = await h.currentSequence();
      await expect(
        h.withOnlyAudioTrack(seq, 1, async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(f.audio.map((t) => f.muted.get(t) ?? false)).toEqual([false, false, false, false]);
    });
    it("leaves out earlier voice fix takes and muted tracks", async () => {
      const f = fakePremiere({
        audio: [
          [footage],
          [{ path: "/Edits/Kilnframe/Main-20261107/voice-fix/fix.wav", start: 2, end: 6 }],
          [{ path: "C:\\Edits\\Kilnframe\\Main-1\\voice-fix\\fix.wav", start: 2, end: 6 }],
          [lav],
        ],
      });
      f.muted.set(f.audio[3]!, true);
      const h = f.make();
      expect(await h.speechTracksAt(await h.currentSequence(), 2, 9)).toEqual([0]);
    });

    it("is not isolated when Premiere refuses to mute a track, and unmutes the others", async () => {
      const f = fakePremiere({ audio: audio() });
      f.muteRule.fn = (clips, mute) => (mute && clips === f.audio[2] ? false : undefined);
      const h = f.make();
      const seq = await h.currentSequence();
      let during: boolean[] = [];
      const out = await h.withOnlyAudioTrack(seq, 1, async () => {
        during = f.audio.map((t) => f.muted.get(t) ?? false);
        return 1;
      });
      expect(out).toEqual({ result: 1, isolated: false });
      expect(during).toEqual([true, false, false, true]);
      expect(f.audio.map((t) => f.muted.get(t) ?? false)).toEqual([false, false, false, false]);
    });

    it("is not isolated when muting a track throws, and unmutes the others", async () => {
      const f = fakePremiere({ audio: audio() });
      f.muteRule.fn = (clips, mute) => {
        if (mute && clips === f.audio[0]) throw new Error("mute");
      };
      const h = f.make();
      const seq = await h.currentSequence();
      const out = await h.withOnlyAudioTrack(seq, 1, async () => 1);
      expect(out).toEqual({ result: 1, isolated: false });
      expect(f.audio.map((t) => f.muted.get(t) ?? false)).toEqual([false, false, false, false]);
    });

    it("unmutes a track whose mute applied and then threw", async () => {
      const f = fakePremiere({ audio: audio() });
      f.muteRule.fn = (clips, mute) => {
        if (mute && clips === f.audio[0]) {
          f.muted.set(clips, true);
          throw new Error("late");
        }
      };
      const h = f.make();
      const seq = await h.currentSequence();
      const out = await h.withOnlyAudioTrack(seq, 1, async () => 1);
      expect(out).toEqual({ result: 1, isolated: false });
      expect(f.audio.map((t) => f.muted.get(t) ?? false)).toEqual([false, false, false, false]);
    });

    it("tries every track and then says so when one cannot be unmuted after the export", async () => {
      const f = fakePremiere({ audio: audio() });
      f.muteRule.fn = (clips, mute) => (!mute && clips === f.audio[0] ? false : undefined);
      const h = f.make();
      const seq = await h.currentSequence();
      await expect(h.withOnlyAudioTrack(seq, 1, async () => 1)).rejects.toThrow();
      expect(f.audio.map((t) => f.muted.get(t) ?? false)).toEqual([true, false, false, false]);
    });

    it("lets the export's error through when unmuting also fails", async () => {
      const f = fakePremiere({ audio: audio() });
      f.muteRule.fn = (clips, mute) => {
        if (!mute && clips === f.audio[0]) throw new Error("unmute");
      };
      const h = f.make();
      const seq = await h.currentSequence();
      await expect(
        h.withOnlyAudioTrack(seq, 1, async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(f.audio.map((t) => f.muted.get(t) ?? false)).toEqual([true, false, false, false]);
    });
  });
});
