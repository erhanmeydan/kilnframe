import { describe, expect, it, vi } from "vitest";
import { createPremiereHost, cutMismatch, planPremiereCut } from "../src/host-premiere";
import type { CutClipInfo } from "../src/host-premiere";
import { frameCuts } from "../src/cut-plan";
import type { HostSequence } from "../src/host";

const TPS = 254016000000;
const FPS = 25;
const TPF = TPS / FPS;

/** A clip in sequence frames; `inF` is its in point in frames of its media at 25 fps. */
interface Rec {
  name: string;
  start: number;
  end: number;
  inF: number;
  speed: number;
  reversed?: boolean;
  /** A transition, not a clip: listed for TrackItemType.TRANSITION only. */
  transition?: boolean;
}

/** A sequence marker at a frame. */
interface MarkerRec {
  name: string;
  f: number;
}

/**
 * A Premiere whose track items behave as measured in Premiere 26.5 (docs/premiere-uxp.md, "Cutting a copy of a
 * sequence"): set start trims (in point follows), set end shrinks or grows, a clone lands at start + offset on
 * the same track with the same in point and length and overwrites what lies under it, a move shifts and never
 * overwrites, and every clip is edited on its own. Set in point is assumed to slip the content (start and end
 * stay): the one behaviour still to be confirmed live.
 */
function fakePremiere(
  tracks: { video: Rec[][]; audio: Rec[][] },
  marks: { markers?: MarkerRec[]; inF?: number | null; outF?: number | null } = {},
) {
  const tick = (ticks: number) => ({ ticks: String(Math.round(ticks)), seconds: ticks / TPS });
  const ticksOf = (t: { ticks: string }) => Number(t.ticks);
  /** Optional sabotage: what set in point does instead (to test the failure paths). */
  const quirks = {
    setInPoint: "slip" as "slip" | "trim" | "throw",
    /** Removing a transition is refused (a selection takes clips only). */
    keepTransitions: false,
    /** getSequences does not list the copy the first time after the clone. */
    copyLate: false,
    /**
     * Clip objects read before a transaction are no longer valid after it (seen live on a long linked clip
     * trimmed in one step and cloned in the next): a stale object throws when used.
     */
    stale: true,
  };
  let generation = 0;
  let inSelection = false;
  /** Each removal: its media type and the names it was given. */
  const removals: { mediaType: number; names: string[] }[] = [];
  const log: string[] = [];
  let wrappers = new WeakMap<Rec, object>();
  type Seq = ReturnType<typeof makeSeq>;
  const seqs: Seq[] = [];
  let active: Seq;

  function makeSeq(
    guid: string,
    name: string,
    video: Rec[][],
    audio: Rec[][],
    m: { markers: MarkerRec[]; inF: number | null; outF: number | null },
  ) {
    const guard = (o: Record<string, unknown>) => {
      const born = generation;
      for (const [k, v] of Object.entries(o))
        if (typeof v === "function")
          o[k] = (...a: unknown[]) => {
            if (quirks.stale && born !== generation)
              throw new Error("The script object is no longer valid.");
            return (v as (...x: unknown[]) => unknown)(...a);
          };
      return o;
    };
    const wrap = (track: Rec[], r: Rec) => {
      if (!wrappers.has(r))
        wrappers.set(
          r,
          guard({
            rec: r,
            getStartTime: async () => tick(r.start * TPF),
            getEndTime: async () => tick(r.end * TPF),
            getInPoint: async () => tick(r.inF * TPF),
            getSpeed: async () => r.speed,
            isSpeedReversed: async () => (r.reversed ? 1 : 0),
            createSetStartAction: (t: { ticks: string }) => () => {
              const f = ticksOf(t) / TPF;
              r.inF += (f - r.start) * r.speed;
              r.start = f;
            },
            createSetEndAction: (t: { ticks: string }) => () => {
              r.end = ticksOf(t) / TPF;
            },
            createSetInPointAction: (t: { ticks: string }) => () => {
              if (quirks.setInPoint === "throw") throw new Error("refused");
              const inF = ticksOf(t) / TPF;
              if (quirks.setInPoint === "trim") r.start += (inF - r.inF) / r.speed;
              r.inF = inF;
            },
            createMoveAction: (t: { ticks: string }) => () => {
              const by = ticksOf(t) / TPF;
              r.start += by;
              r.end += by;
            },
            track,
          }),
        );
      return wrappers.get(r);
    };
    const trackApi = (track: Rec[]) => ({
      getTrackItems: (type: number) =>
        [...track]
          .filter((r) => Boolean(r.transition) === (type === 2))
          .sort((a, b) => a.start - b.start)
          .map((r) => wrap(track, r)),
    });
    // unset In and Out read far before the start, as in Premiere
    const point = (f: number | null) => tick(f === null ? -400000 * TPS : f * TPF);
    const seq = {
      guid: { toString: () => guid },
      name,
      video,
      audio,
      marks: m,
      getInPoint: async () => point(m.inF),
      getOutPoint: async () => point(m.outF),
      createSetInPointAction: (t: { ticks: string }) => () => {
        m.inF = ticksOf(t) / TPF;
      },
      createSetOutPointAction: (t: { ticks: string }) => () => {
        m.outF = ticksOf(t) / TPF;
      },
      getSettings: async () => ({
        getVideoFrameRate: async () => ({ ticksPerFrame: TPF, value: FPS }),
      }),
      getEndTime: async () =>
        tick(
          Math.max(
            0,
            ...[...video, ...audio]
              .flat()
              .filter((r) => !r.transition)
              .map((r) => r.end),
          ) * TPF,
        ),
      getVideoTrackCount: async () => video.length,
      getAudioTrackCount: async () => audio.length,
      getVideoTrack: async (i: number) => trackApi(video[i]),
      getAudioTrack: async (i: number) => trackApi(audio[i]),
      getProjectItem: async () => ({
        createSetNameAction: (n: string) => () => {
          seq.name = n;
        },
      }),
      createCloneAction: () => () => {
        const copy = (t: Rec[][]) => t.map((tr) => tr.map((r) => ({ ...r })));
        seqs.push(
          makeSeq(`guid-${seqs.length + 1}`, `${seq.name} Copy`, copy(video), copy(audio), {
            markers: m.markers.map((x) => ({ ...x })),
            inF: m.inF,
            outF: m.outF,
          }),
        );
      },
    };
    return seq;
  }

  active = makeSeq("guid-1", "Main", tracks.video, tracks.audio, {
    markers: marks.markers ?? [],
    inF: marks.inF ?? null,
    outF: marks.outF ?? null,
  });
  seqs.push(active);
  const original = JSON.stringify({ tracks, marks });
  let late = false;

  const project = {
    getActiveSequence: async () => active,
    getSequences: async () => {
      if (quirks.copyLate && seqs.length > 1 && !late) {
        late = true;
        return seqs.slice(0, 1);
      }
      return [...seqs];
    },
    lockedAccess: (fn: () => void) => fn(),
    executeTransaction: (fn: (c: { addAction(a: () => void): boolean }) => void, label: string) => {
      log.push(label);
      const queued: (() => void)[] = [];
      fn({ addAction: (a) => (queued.push(a), true) });
      for (const a of queued) a();
      if (quirks.stale) {
        generation++;
        wrappers = new WeakMap();
      }
      return true;
    },
    deleteSequence: vi.fn(async (s: Seq) => {
      seqs.splice(seqs.indexOf(s), 1);
      return true;
    }),
    openSequence: vi.fn(async () => true),
    setActiveSequence: vi.fn(async (s: Seq) => {
      active = s;
      return true;
    }),
  };
  type Item = { rec: Rec; track: Rec[] };
  const ppro = {
    Project: { getActiveProject: async () => project },
    TickTime: {
      TIME_ONE_SECOND: { ticksNumber: TPS },
      createWithTicks: (s: string) => tick(Number(s)),
      createWithSeconds: (s: number) => tick(s * TPS),
    },
    Constants: {
      TrackItemType: { CLIP: 1, TRANSITION: 2 },
      MediaType: { ANY: 0, VIDEO: 1, AUDIO: 2 },
    },
    Markers: {
      getMarkers: async (s: Seq) => {
        type W = { rec: MarkerRec; getStart: () => unknown };
        return {
          getMarkers: () =>
            s.marks.markers.map((rec) => ({ rec, getStart: () => tick(rec.f * TPF) })),
          createMoveMarkerAction: (w: W, t: { ticks: string }) => () => {
            w.rec.f = ticksOf(t) / TPF;
          },
          createRemoveMarkerAction: (w: W) => () => {
            s.marks.markers.splice(s.marks.markers.indexOf(w.rec), 1);
          },
        };
      },
    },
    TrackItemSelection: {
      createEmptySelection: (cb: (s: unknown) => void) => {
        // a selection made inside another's callback crashed Premiere 26.5 (11 Nov 2026)
        if (inSelection) throw new Error("Premiere crashed: a selection inside a selection");
        const items: Item[] = [];
        inSelection = true;
        try {
          cb({ items, addItem: (it: Item) => (items.push(it), true) });
        } finally {
          inSelection = false;
        }
        return true;
      },
    },
    SequenceEditor: {
      getEditor: () => ({
        createRemoveItemsAction:
          (sel: { items: Item[] }, _ripple: boolean, mediaType: number) => () => {
            if (quirks.keepTransitions && sel.items.some((it) => it.rec.transition))
              throw new Error("not a clip");
            removals.push({ mediaType, names: sel.items.map((it) => it.rec.name) });
            for (const it of sel.items) it.track.splice(it.track.indexOf(it.rec), 1);
          },
        createCloneTrackItemAction:
          (
            it: Item,
            offset: { ticks: string },
            v: number,
            a: number,
            _align: boolean,
            insert: boolean,
          ) =>
          () => {
            if (v || a || insert) throw new Error("not measured");
            const by = Math.round(ticksOf(offset) / TPF);
            const copy = { ...it.rec, start: it.rec.start + by, end: it.rec.end + by };
            // an overwrite: what lay under the copy is cut away
            const kept = it.track.flatMap((r) =>
              r.end <= copy.start || r.start >= copy.end
                ? [r]
                : [
                    ...(r.start < copy.start ? [{ ...r, end: copy.start }] : []),
                    ...(r.end > copy.end
                      ? [{ ...r, inF: r.inF + (copy.end - r.start) * r.speed, start: copy.end }]
                      : []),
                  ],
            );
            it.track.splice(0, it.track.length, ...kept, copy);
          },
      }),
    },
  };
  const host = createPremiereHost(ppro as never, {} as never, {} as never, { homedir: () => "/" });
  const seq: HostSequence = {
    id: "guid-1",
    name: "Main",
    projectPath: "/p.prproj",
    fps: "25",
    fpsValue: 25,
    width: 1920,
    height: 1080,
    inSeconds: 0,
    outSeconds: 0,
    endSeconds: 0,
    videoTracks: tracks.video.length,
    audioTracks: tracks.audio.length,
  };
  return {
    host,
    seq,
    seqs,
    project,
    quirks,
    log,
    removals,
    originalUntouched: () => JSON.stringify({ tracks, marks }) === original,
    active: () => active,
  };
}

const clip = (name: string, start: number, end: number, inF = 0, speed = 1): Rec => ({
  name,
  start,
  end,
  inF,
  speed,
});
const sorted = (t: Rec[]) =>
  [...t]
    .sort((a, b) => a.start - b.start)
    .map((r) => [r.name, r.start, r.end, Math.round(r.inF * 1000) / 1000]);
/** Seconds at 25 fps. */
const s = (f: number) => f / FPS;

describe("Premiere cutToNewSequence (clone and cut)", () => {
  it("cuts one linked clip at three pauses on both tracks into a new, active sequence", async () => {
    // a 10 s clip from 2 s into its media; pauses 2-3 s, 5-5.5 s, 8-9 s
    const f = fakePremiere({ video: [[clip("v", 0, 250, 50)]], audio: [[clip("a", 0, 250, 50)]] });
    const progress: number[] = [];
    const r = await f.host.cutToNewSequence!(
      f.seq,
      [
        { startS: 2, endS: 3 },
        { startS: 5, endS: 5.5 },
        { startS: 8, endS: 9 },
      ],
      "Main Pauses Removed",
      (done) => progress.push(done),
    );
    // on frames: cuts 50-75, 125-137 (5.5 s is frame 137.5, rounded down), 200-225
    const pieces = (n: string) => [
      [n, 0, 50, 50],
      [n, 50, 100, 125],
      [n, 100, 163, 187],
      [n, 163, 188, 275],
    ];
    const clone = f.seqs[1];
    expect(sorted(clone.video[0])).toEqual(pieces("v"));
    expect(sorted(clone.audio[0])).toEqual(pieces("a"));
    expect(r).toEqual({ id: "guid-2", name: "Main Pauses Removed", leftOut: 0, rebuilt: false });
    expect(clone.name).toBe("Main Pauses Removed");
    expect(f.active()).toBe(clone);
    expect(f.originalUntouched()).toBe(true);
    expect(progress.at(-1)).toBeGreaterThan(progress[0]);
  });

  it("reads the clips again after each step, as Premiere drops the objects read before one", async () => {
    // a long linked clip trimmed in one step, its pieces copied in the next (failed live with stale objects)
    const f = fakePremiere({ video: [[clip("v", 0, 250, 50)]], audio: [[clip("a", 0, 250, 50)]] });
    f.quirks.stale = true;
    await f.host.cutToNewSequence!(
      f.seq,
      [
        { startS: 2, endS: 3 },
        { startS: 8, endS: 9 },
      ],
      "Main Pauses Removed",
    );
    expect(sorted(f.seqs[1].video[0]).map((p) => p.slice(1, 3))).toEqual([
      [0, 50],
      [50, 175],
      [175, 200],
    ]);
  });

  it("removes a clip that lies wholly inside a pause and closes the gap", async () => {
    const f = fakePremiere({
      video: [[clip("a", 0, 50), clip("b", 50, 75), clip("c", 75, 150)]],
      audio: [[]],
    });
    await f.host.cutToNewSequence!(f.seq, [{ startS: s(50), endS: s(75) }], "X");
    expect(sorted(f.seqs[1].video[0])).toEqual([
      ["a", 0, 50, 0],
      ["c", 50, 125, 0],
    ]);
  });

  it("splits a title on an upper track that spans a pause, in sync with the track under it", async () => {
    const f = fakePremiere({
      video: [[clip("v", 0, 200)], [clip("title", 25, 125)]],
      audio: [[clip("a", 0, 200)]],
    });
    await f.host.cutToNewSequence!(f.seq, [{ startS: s(50), endS: s(100) }], "X");
    expect(sorted(f.seqs[1].video[1])).toEqual([
      ["title", 25, 50, 0],
      ["title", 50, 75, 75],
    ]);
    expect(sorted(f.seqs[1].video[0])).toEqual([
      ["v", 0, 50, 0],
      ["v", 50, 150, 100],
    ]);
  });

  it("deletes the copy and leaves the original alone when a step fails", async () => {
    const f = fakePremiere({ video: [[clip("v", 0, 250)]], audio: [[]] });
    f.quirks.setInPoint = "throw";
    await expect(
      f.host.cutToNewSequence!(
        f.seq,
        [
          { startS: 2, endS: 3 },
          { startS: 5, endS: 6 },
        ],
        "X",
      ),
    ).rejects.toThrow();
    expect(f.project.deleteSequence).toHaveBeenCalledTimes(1);
    expect(f.seqs).toHaveLength(1);
    expect(f.originalUntouched()).toBe(true);
    expect(f.project.setActiveSequence).not.toHaveBeenCalled();
  });

  it("deletes the copy when the read back differs from the plan", async () => {
    const f = fakePremiere({ video: [[clip("v", 0, 250)]], audio: [[]] });
    f.quirks.setInPoint = "trim";
    const err = await f.host.cutToNewSequence!(
      f.seq,
      [
        { startS: 2, endS: 3 },
        { startS: 5, endS: 6 },
      ],
      "X",
    ).catch((e: Error) => e);
    expect(String((err as Error).cause)).toMatch(/V1/);
    expect(f.seqs).toHaveLength(1);
  });

  it("runs every phase as one transaction and skips the empty ones", async () => {
    const f = fakePremiere({ video: [[clip("v", 0, 250)]], audio: [[]] });
    await f.host.cutToNewSequence!(f.seq, [{ startS: 2, endS: 3 }], "X");
    // clone, rename, trim to the seed, clone the seed, set its in point and end, move left
    expect(f.log).toHaveLength(6);
  });

  it("moves the copy's markers and In/Out with their content; a marker inside a cut goes", async () => {
    const f = fakePremiere(
      { video: [[clip("v", 0, 250)]], audio: [[clip("a", 0, 250)]] },
      {
        markers: [
          { name: "before", f: 10 },
          { name: "inside", f: 60 },
          { name: "after", f: 200 },
        ],
        inF: 100,
        outF: 70,
      },
    );
    await f.host.cutToNewSequence!(f.seq, [{ startS: 2, endS: 3 }], "X");
    const copy = f.seqs[1]!;
    expect(copy.marks.markers).toEqual([
      { name: "before", f: 10 },
      { name: "after", f: 175 },
    ]);
    // In after the cut moves left; an Out inside it goes to its edge
    expect(copy.marks.inF).toBe(75);
    expect(copy.marks.outF).toBe(50);
    expect(f.originalUntouched()).toBe(true);
  });

  it("leaves an unset In and Out unset", async () => {
    const f = fakePremiere({ video: [[clip("v", 0, 250)]], audio: [[]] });
    await f.host.cutToNewSequence!(f.seq, [{ startS: 2, endS: 3 }], "X");
    expect(f.seqs[1]!.marks).toEqual({ markers: [], inF: null, outF: null });
  });

  it("takes transitions at the cuts off the copy and keeps the others", async () => {
    const tr = (name: string, start: number, end: number): Rec => ({
      ...clip(name, start, end),
      transition: true,
    });
    const f = fakePremiere({
      video: [[clip("v1", 0, 100), clip("v2", 100, 250), tr("at-cut", 45, 55), tr("far", 95, 105)]],
      audio: [[clip("a", 0, 250)]],
    });
    await f.host.cutToNewSequence!(f.seq, [{ startS: 2, endS: 3 }], "X");
    const left = f.seqs[1]!.video[0]!.filter((r) => r.transition).map((r) => r.name);
    expect(left).toEqual(["far"]);
    expect(f.removals[0]).toEqual({ mediaType: 0, names: ["at-cut"] });
  });

  it("refuses with the editor's words when Premiere keeps the transitions, and deletes the copy", async () => {
    const f = fakePremiere({
      video: [[clip("v", 0, 250), { ...clip("t", 45, 55), transition: true }]],
      audio: [[]],
    });
    f.quirks.keepTransitions = true;
    await expect(f.host.cutToNewSequence!(f.seq, [{ startS: 2, endS: 3 }], "X")).rejects.toThrow(
      "Remove those transitions and try again",
    );
    expect(f.seqs).toHaveLength(1);
    expect(f.originalUntouched()).toBe(true);
  });

  it("removes video and audio clips in separate selections of their own media type", async () => {
    const f = fakePremiere({
      video: [[clip("v1", 0, 50), clip("vgone", 50, 75), clip("v3", 75, 150)]],
      audio: [[clip("a1", 0, 50), clip("agone", 50, 75), clip("a3", 75, 150)]],
    });
    await f.host.cutToNewSequence!(f.seq, [{ startS: s(50), endS: s(75) }], "X");
    expect(f.removals).toEqual([
      { mediaType: 1, names: ["vgone"] },
      { mediaType: 2, names: ["agone"] },
    ]);
  });

  it("deletes a copy found only on a second look, before saying it was not found", async () => {
    const f = fakePremiere({ video: [[clip("v", 0, 250)]], audio: [[]] });
    f.quirks.copyLate = true;
    const err = await f.host.cutToNewSequence!(f.seq, [{ startS: 2, endS: 3 }], "X").catch(
      (e: Error) => e,
    );
    expect(String((err as Error).cause)).toMatch(/not found/);
    expect(f.seqs).toHaveLength(1);
  });

  it("changes nothing but the copy's name when there are no pauses", async () => {
    const f = fakePremiere({ video: [[clip("v", 0, 250)]], audio: [[]] });
    await f.host.cutToNewSequence!(f.seq, [], "X");
    expect(sorted(f.seqs[1].video[0])).toEqual([["v", 0, 250, 0]]);
    expect(f.log).toHaveLength(2);
  });
});

describe("planPremiereCut", () => {
  const info = (over: Partial<CutClipInfo["plan"]> = {}, rest: Partial<CutClipInfo> = {}) => ({
    plan: { key: "video:0:0", track: 0, kind: "video" as const, startF: 0, endF: 300, ...over },
    inTicks: 0,
    speed: 1,
    reversed: false,
    ...rest,
  });
  const cuts = frameCuts(
    [
      { startS: 2, endS: 3 },
      { startS: 6, endS: 6.4 },
    ],
    FPS,
    1000,
  );

  it("seeds an item at its shortest piece and clones it into every further piece", () => {
    // pieces 0-50, 75-150, 160-300: the shortest is 50
    const p = planPremiereCut([info()], cuts, TPF);
    expect(p.trims).toEqual([{ key: "video:0:0", startF: null, endF: 50 }]);
    expect(p.clones).toEqual([
      { key: "video:0:0", offsetF: 75 },
      { key: "video:0:0", offsetF: 160 },
    ]);
    expect(p.fixes).toEqual([
      { kind: "video", track: 0, atF: 75, inTicks: 75 * TPF, endF: 150 },
      { kind: "video", track: 0, atF: 160, inTicks: 160 * TPF, endF: 300 },
    ]);
    expect(p.moves).toEqual([
      { kind: "video", track: 0, atF: 75, byF: -25 },
      { kind: "video", track: 0, atF: 160, byF: -35 },
    ]);
  });

  it("scales the in point by the clip's speed", () => {
    const p = planPremiereCut([info({}, { speed: 2, inTicks: 10 * TPF })], cuts, TPF);
    expect(p.fixes[0].inTicks).toBe(10 * TPF + 150 * TPF);
  });

  it("keeps only the first piece of a reversed clip and counts it as left out", () => {
    const p = planPremiereCut([info({}, { reversed: true })], cuts, TPF);
    expect(p.leftOut).toBe(1);
    expect(p.clones).toEqual([]);
    expect(p.trims).toEqual([{ key: "video:0:0", startF: null, endF: 50 }]);
    expect(p.expected).toEqual([{ kind: "video", track: 0, startF: 0, endF: 50, inTicks: null }]);
  });

  it("orders the moves left to right on each track", () => {
    const p = planPremiereCut(
      [info({ key: "b", startF: 200, endF: 300 }), info({ key: "a", startF: 60, endF: 150 })],
      cuts,
      TPF,
    );
    expect(p.moves.map((m) => m.atF)).toEqual([75, 200]);
  });
});

describe("cutMismatch", () => {
  const e = { kind: "audio" as const, track: 1, startF: 0, endF: 10, inTicks: 0 };
  it("names the track and the frames that differ", () => {
    expect(cutMismatch([e], [{ ...e, endF: 11 }], TPF)).toMatch(/A2.*0-10.*0-11/);
    expect(cutMismatch([e], [], TPF)).toMatch(/A2/);
    expect(cutMismatch([e], [{ ...e }], TPF)).toBeNull();
  });
});
