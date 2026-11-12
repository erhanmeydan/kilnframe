import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  barSegments,
  cutName,
  unheardNote,
  newPauses,
  pausesAct,
  previewTotals,
  pausesBox,
  pausesWatches,
  type PausesState,
} from "../src/pauses";

const SEQ = {
  id: "seq-1",
  name: "Talk",
  projectPath: "/p/a.prproj",
  fps: "25",
  fpsValue: 25,
  width: 1920,
  height: 1080,
  inSeconds: 100,
  outSeconds: 200,
  endSeconds: 760,
  videoTracks: 1,
  audioTracks: 2,
};

const tick = () => new Promise((r) => setTimeout(r, 0));

type Msg = { type: string; params?: Record<string, unknown>; [k: string]: unknown };

const PLAN = {
  type: "pauses.cuts",
  cuts: [
    { startS: 1, endS: 3 },
    { startS: 10, endS: 12.5 },
  ],
  removedS: 4.5,
  keptS: 95.5,
  longKept: [],
  emptied: false,
};

/** A panel around the tab: records what goes to the companion and to the editor. */
function fakeCtx(
  o: {
    tracks?: number[];
    range?: boolean;
    cut?: boolean;
    kind?: "premiere" | "resolve" | "filmcraft";
    seq?: () => typeof SEQ;
    cutReply?: Record<string, unknown>;
    cutError?: string;
    /** The export waits for this before it ends (a long sequence). */
    exportGate?: Promise<void>;
  } = {},
) {
  const sent: Msg[] = [];
  const exports: unknown[][] = [];
  const soloed: (number | number[])[] = [];
  const cutCalls: unknown[][] = [];
  const store: Record<string, string> = {};
  let renders = 0;
  let listener: (m: Record<string, unknown>) => void = () => undefined;
  const ctx: Record<string, unknown> = {
    esc: (s: string) => s,
    reportLink: () => "",
    seg: (name: string, value: string, options: [string, string][]) =>
      options
        .map(
          ([v, l]) =>
            `<div data-act="${name}" data-val="${v}"${v === value ? " on" : ""}>${l}</div>`,
        )
        .join(""),
    render: () => void renders++,
    trace: () => undefined,
    connected: () => true,
    inOut: () =>
      o.range === false
        ? null
        : { startS: 100, endS: 200, durationS: 100, source: "inout", warning: null },
    rangeLine: () => "",
    readSequence: async () => (o.seq ? o.seq() : SEQ),
    request: async (m: Msg) => {
      sent.push(m);
      if (m.type === "job.prepare") return { jobDir: "/j" };
      if (m.type === "job.start") return { jobId: "job-1" };
      if (m.type === "pauses.cuts") {
        if (o.cutError) throw new Error(o.cutError);
        return o.cutReply ?? PLAN;
      }
      return {};
    },
    send: (m: Msg) => sent.push(m),
    on: (fn: typeof listener) => ((listener = fn), () => undefined),
    speechTracksAt: async () => o.tracks ?? [0],
    withOnlyAudioTrack: async (_s: unknown, t: number | number[], fn: () => Promise<unknown>) => {
      soloed.push(t);
      return { result: await fn(), isolated: true };
    },
    exportAudio: async (...args: unknown[]) => {
      exports.push(args.slice(1));
      if (o.exportGate) await o.exportGate;
      return { ok: true, offsetSeconds: 0 };
    },
    renderSettingsLost: async () => false,
    stored: (k: string) => store[k] ?? null,
    store: (k: string, v: string) => void (store[k] = v),
    hostKind: () => o.kind ?? "premiere",
  };
  if (o.cut !== false)
    ctx.cutToNewSequence = async (...args: unknown[]) => {
      cutCalls.push(args);
      const progress = args[3] as ((d: number, t: number) => void) | undefined;
      progress?.(1, 2);
      return { id: "seq-2", name: String(args[2]), leftOut: 0, rebuilt: false, ...o.cutReply };
    };
  return {
    soloed,
    ctx: ctx as never,
    sent,
    exports,
    cutCalls,
    store,
    renders: () => renders,
    emit: (m: Record<string, unknown>) => listener(m),
  };
}

function atPreview(extra: Partial<PausesState> = {}): PausesState {
  return {
    ...newPauses(),
    stage: "preview",
    jobDir: "/j",
    seqId: "seq-1",
    seqName: "Talk",
    seqEndS: 760,
    fps: 25,
    tracksSeen: { video: 1, audio: 2 },
    scope: "range",
    rangeStartS: 100,
    tracks: [0],
    listened: [0],
    speech: [
      [0, 1],
      [3, 10],
      [12.5, 100],
    ],
    durationS: 100,
    plan: {
      cuts: PLAN.cuts,
      removedS: PLAN.removedS,
      keptS: PLAN.keptS,
      longKept: [],
      emptied: false,
    },
    ...extra,
  };
}

const jobs = (sent: Msg[]) => sent.filter((m) => m.type === "job.start").map((m) => m.params!);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("remove pauses panel", () => {
  it("offers no scope choice: the range line shows which part is listened to", () => {
    const f = fakeCtx();
    (f.ctx as unknown as Record<string, unknown>).rangeLine = () => "[range line]";
    const html = pausesBox(newPauses(), f.ctx);
    expect(html).not.toContain("pauses-scope");
    expect(html).toContain("[range line]");
    expect(html).toContain('data-act="pauses-find"');
  });

  it("says when a track with sound was not listened to, and nothing when all were", () => {
    const st = { ...newPauses(), tracks: [0, 1], listened: [0] };
    expect(unheardNote(st)).toContain("Only Audio 1 was listened to. Audio 2 has sound too");
    expect(unheardNote({ ...st, listened: [0, 1] })).toBe("");
    expect(unheardNote({ ...st, tracks: [0] })).toBe("");
  });

  it("says so in an editor that cannot cut yet, and offers no Find", () => {
    const html = pausesBox(newPauses(), fakeCtx({ cut: false }).ctx);
    expect(html).toContain("not available in this editor yet");
    expect(html).not.toMatch(/class="btn mt" data-act="pauses-find"/);
  });

  it("marks every track with sound, listens to the marked ones together, and goes straight on with one", async () => {
    const many = fakeCtx({ tracks: [0, 2] });
    const st = newPauses();
    pausesAct(st, many.ctx, "pauses-find");
    await tick();
    expect(st.stage).toBe("track");
    expect(st.picked).toEqual([0, 2]);
    expect(pausesBox(st, many.ctx)).toContain("Mark the ones with speech");
    expect(jobs(many.sent)).toHaveLength(0);
    // unmarking one, then listening: only the marked track is heard
    pausesAct(st, many.ctx, "pauses-track", "2");
    expect(st.picked).toEqual([0]);
    pausesAct(st, many.ctx, "pauses-track", "2");
    expect(st.picked).toEqual([0, 2]);
    pausesAct(st, many.ctx, "pauses-listen");
    await tick();
    expect(st.stage).toBe("listening");
    expect(st.listened).toEqual([0, 2]);
    expect(many.soloed.at(-1)).toEqual([0, 2]);

    const one = fakeCtx({ range: false });
    const st1 = newPauses();
    pausesAct(st1, one.ctx, "pauses-find");
    await tick();
    expect(st1.stage).toBe("listening");
    expect(jobs(one.sent)).toEqual([
      {
        kind: "pauses-find",
        audioPath: "/j/export.wav",
        rangeStartS: 0,
        rangeEndS: 760,
        outDir: "/j/pauses",
      },
    ]);
    // no In/Out: the whole sequence
    expect(one.exports[0]).toEqual([0, 760, "/j/export.wav"]);
  });

  it("listens to the In/Out range whenever the sequence has one", async () => {
    const f = fakeCtx();
    const st = newPauses();
    pausesAct(st, f.ctx, "pauses-find");
    await tick();
    expect(f.exports[0]).toEqual([100, 200, "/j/export.wav"]);
    expect(st.rangeStartS).toBe(100);
    f.emit({ type: "job.done", jobId: "job-1", result: { speech: [[0, 5]], durationS: 100 } });
    await tick();
    // a part of a longer timeline: the cuts keep a pad at its edges
    expect(f.sent.find((m) => m.type === "pauses.cuts")).toMatchObject({ rangeEdges: true });
  });

  it("says when no track has sound", async () => {
    const f = fakeCtx({ tracks: [] });
    const st = newPauses();
    pausesAct(st, f.ctx, "pauses-find");
    await tick();
    expect(st.stage).toBe("idle");
    expect(st.error).toContain("No audio track has sound");
  });

  it("enters the preview with the job's speech and asks for the cuts", async () => {
    const f = fakeCtx({ range: false });
    const st = newPauses();
    pausesAct(st, f.ctx, "pauses-find");
    await tick();
    f.emit({
      type: "job.done",
      jobId: "job-1",
      result: { kind: "pauses-find", speech: [[0, 5]], durationS: 760 },
    });
    await tick();
    expect(st.stage).toBe("preview");
    const asked = f.sent.filter((m) => m.type === "pauses.cuts");
    expect(asked).toEqual([
      { type: "pauses.cuts", speech: [[0, 5]], durationS: 760, strictness: 0.5, keepLongS: null },
    ]);
    const html = pausesBox(st, f.ctx);
    // 4.5 s asked, 4.52 s on the 25 fps grid (12.5 s is mid frame: the cut ends on the nearest frame, up)
    expect(html).toContain("2 pauses, 5 s shorter. 12:40 becomes 12:35.");
    expect(html).toContain('data-act="pauses-apply"');
    expect(html).toContain("Create Sequence Without Pauses");
  });

  it("says when no speech was found", async () => {
    const f = fakeCtx();
    const st = newPauses();
    pausesAct(st, f.ctx, "pauses-find");
    await tick();
    f.emit({ type: "job.done", jobId: "job-1", result: { speech: [], durationS: 760 } });
    await tick();
    expect(st.stage).toBe("idle");
    expect(st.error).toBe("No speech was found on this track.");
  });

  it("sends one request for a slider move, after a short pause, and remembers the setting", async () => {
    vi.useFakeTimers();
    const f = fakeCtx({ cutReply: { ...PLAN, cuts: [{ startS: 1, endS: 3 }], removedS: 2 } });
    const st = atPreview();
    pausesAct(st, f.ctx, "pauses-strict", "0.6");
    pausesAct(st, f.ctx, "pauses-strict", "0.7");
    pausesAct(st, f.ctx, "pauses-strict", "0.8");
    expect(f.sent.filter((m) => m.type === "pauses.cuts")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    const asked = f.sent.filter((m) => m.type === "pauses.cuts");
    expect(asked).toHaveLength(1);
    expect(asked[0]!.strictness).toBe(0.8);
    expect(st.plan!.removedS).toBe(2);
    expect(pausesBox(st, f.ctx)).toContain("1 pause, 2 s shorter.");
    expect(f.store["pauses-strict:seq-1"]).toBe("0.8");
  });

  it("hides the button when the cut would remove almost everything", () => {
    const html = pausesBox(
      atPreview({ plan: { cuts: [], removedS: 0, keptS: 100, longKept: [], emptied: true } }),
      fakeCtx().ctx,
    );
    expect(html).toContain("Nothing was cut");
    expect(html).not.toContain('data-act="pauses-apply"');
  });

  it("hides the button when no pause is long enough", () => {
    const html = pausesBox(
      atPreview({ plan: { cuts: [], removedS: 0, keptS: 100, longKept: [], emptied: false } }),
      fakeCtx().ctx,
    );
    expect(html).toContain("No pause is long enough");
    expect(html).not.toContain('data-act="pauses-apply"');
  });

  it("applies the cuts in sequence seconds into a new sequence named after the original", async () => {
    const f = fakeCtx();
    const st = atPreview();
    pausesAct(st, f.ctx, "pauses-apply");
    await tick();
    await tick();
    expect(f.cutCalls).toHaveLength(1);
    const [, cuts, name] = f.cutCalls[0]!;
    expect(cuts).toEqual([
      { startS: 101, endS: 103 },
      { startS: 110, endS: 112.5 },
    ]);
    expect(name).toBe("Talk (No Pauses)");
    expect(st.stage).toBe("done");
    const html = pausesBox(st, f.ctx);
    expect(html).toContain('"Talk (No Pauses)" is open. Your original sequence is unchanged.');
    expect(html).not.toContain("left out");
    expect(html).toContain('data-act="pauses-again"');
  });

  it("refuses to apply when the sequence changed after Find", async () => {
    const f = fakeCtx({ seq: () => ({ ...SEQ, endSeconds: 800 }) });
    const st = atPreview();
    pausesAct(st, f.ctx, "pauses-apply");
    await tick();
    expect(f.cutCalls).toHaveLength(0);
    expect(st.error).toBe("The sequence changed after the pauses were found. Find them again.");
    expect(st.stage).toBe("idle");
  });

  it("tells what was left out and that a rebuilt sequence lost its effects", async () => {
    const f = fakeCtx({ cutReply: { leftOut: 3, rebuilt: true } });
    const st = atPreview();
    pausesAct(st, f.ctx, "pauses-apply");
    await tick();
    await tick();
    const html = pausesBox(st, f.ctx);
    expect(html).toContain("3 clips could not be carried over");
    expect(html).toContain("grades, effects and titles are not copied");
  });

  it("warns in Resolve before applying that the timeline is rebuilt", () => {
    expect(pausesBox(atPreview(), fakeCtx({ kind: "resolve" }).ctx)).toContain(
      "grades, effects and titles are not copied",
    );
    expect(pausesBox(atPreview(), fakeCtx().ctx)).not.toContain("not copied");
  });

  it("returns to idle with Stopped when the editor stops the listening", async () => {
    const f = fakeCtx();
    const st = newPauses();
    pausesAct(st, f.ctx, "pauses-find");
    await tick();
    expect(pausesBox(st, f.ctx)).toContain('data-act="pauses-stop"');
    pausesAct(st, f.ctx, "pauses-stop");
    expect(f.sent).toContainEqual({ type: "job.cancel", jobId: "job-1" });
    f.emit({ type: "job.cancelled", jobId: "job-1" });
    expect(st.stage).toBe("idle");
    expect(st.error).toBe("The job was stopped.");
  });

  it("offers Stop during the export too, and drops the export's late result", async () => {
    let finish = () => undefined as void;
    const gate = new Promise<void>((r) => (finish = r));
    const f = fakeCtx({ exportGate: gate });
    const st = newPauses();
    pausesAct(st, f.ctx, "pauses-find");
    await tick();
    expect(f.exports).toHaveLength(1);
    expect(st.jobId).toBeNull();
    expect(pausesBox(st, f.ctx)).toContain('data-act="pauses-stop"');
    pausesAct(st, f.ctx, "pauses-stop");
    expect(st.stage).toBe("idle");
    expect(st.error).toBe("The job was stopped.");
    finish();
    await tick();
    await tick();
    // no job for the stopped run, and the tab stays as Stop left it
    expect(jobs(f.sent)).toHaveLength(0);
    expect(st.stage).toBe("idle");
    // a new Find runs as usual
    const g = fakeCtx();
    pausesAct(st, g.ctx, "pauses-find");
    await tick();
    expect(jobs(g.sent)).toHaveLength(1);
  });

  it("offers no Stop while the new sequence is built", () => {
    const html = pausesBox(
      atPreview({ stage: "applying", progress: { done: 3, total: 9 } }),
      fakeCtx().ctx,
    );
    expect(html).toContain("Building the new sequence, 3 of 9.");
    expect(html).not.toContain("pauses-stop");
  });

  it("shows and clears a slider error in place, without a full render that would end the drag", async () => {
    const slots: Record<string, { innerHTML: string }> = {
      "pauses-live": { innerHTML: "" },
      "pauses-apply-slot": { innerHTML: "" },
      "pauses-errors": { innerHTML: "" },
    };
    vi.stubGlobal("document", { getElementById: (id: string) => slots[id] ?? null });
    const bad = fakeCtx({ cutError: "connection lost" });
    const st = atPreview();
    pausesAct(st, bad.ctx, "pauses-strict", "0.4");
    await new Promise((r) => setTimeout(r, 120));
    expect(st.error).toContain("connection lost");
    expect(slots["pauses-errors"]!.innerHTML).toContain("connection lost");
    expect(bad.renders()).toBe(0);
    const good = fakeCtx();
    pausesAct(st, good.ctx, "pauses-strict", "0.5");
    await new Promise((r) => setTimeout(r, 120));
    expect(st.error).toBeNull();
    expect(slots["pauses-errors"]!.innerHTML).toBe("");
    expect(good.renders()).toBe(0);
  });

  it("says an older app needs updating", async () => {
    const f = fakeCtx({ cutError: "Invalid message: Invalid input" });
    const st = atPreview();
    pausesAct(st, f.ctx, "pauses-strict", "0.4");
    await new Promise((r) => setTimeout(r, 120));
    expect(st.error).toContain("older than this panel");
  });

  it("watches the sequence only before Find and after the cut", () => {
    expect(pausesWatches(newPauses())).toBe(true);
    expect(pausesWatches(atPreview())).toBe(false);
    expect(pausesWatches(atPreview({ stage: "done" }))).toBe(true);
  });

  it("previews what the hosts cut: each cut snapped to whole frames, merged when they touch", () => {
    const cuts = [
      { startS: 1.01, endS: 3.03 }, // sequence frames 2526..2576 at 25 fps (start up, end to the nearest)
      { startS: 3.03, endS: 3.5 }, // snaps to 2576..2588: touches the first, so one cut of 62 frames
      { startS: 10.5, endS: 10.52 }, // under a frame after snapping: not a cut at all
    ];
    const st = atPreview({
      rangeStartS: 100,
      plan: { cuts, removedS: 2.51, keptS: 97.49, longKept: [], emptied: false },
    });
    const totals = previewTotals(st);
    expect(totals.count).toBe(1);
    expect(totals.removedS).toBeCloseTo(62 / 25, 9);
    expect(totals.afterS).toBeCloseTo(760 - 62 / 25, 9);
    // the bar shows the snapped cuts, in seconds of the part listened to
    expect(totals.cuts[0]!.startS).toBeCloseTo(2526 / 25 - 100, 9);
    expect(totals.cuts[0]!.endS).toBeCloseTo(2588 / 25 - 100, 9);
    // without a frame rate (an older state) the plan's own seconds are shown
    expect(previewTotals(atPreview({ fps: 0, plan: { ...st.plan!, cuts } })).removedS).toBe(2.51);
  });

  it("draws the bar as kept and cut parts that fill it", () => {
    const parts = barSegments(atPreview().plan!, 100);
    expect(parts.map((p) => p.kind)).toEqual(["keep", "cut", "keep", "cut", "keep"]);
    expect(parts.reduce((s, p) => s + p.width, 0)).toBeCloseTo(100);
    expect(parts[1]).toEqual({ kind: "cut", left: 1, width: 2 });
    expect(
      barSegments(
        { cuts: [{ startS: 0, endS: 100 }], removedS: 100, keptS: 0, longKept: [], emptied: false },
        100,
      ),
    ).toEqual([{ kind: "cut", left: 0, width: 100 }]);
  });

  it("has every pauses key in both languages, without dashes in Turkish", () => {
    const read = (l: string) =>
      JSON.parse(
        readFileSync(new URL(`../src/locales/${l}.json`, import.meta.url), "utf8"),
      ) as Record<string, string>;
    const en = read("en");
    const tr = read("tr");
    const keys = (o: Record<string, string>) =>
      Object.keys(o)
        .filter((k) => k.startsWith("pauses.") || k === "tab.pauses")
        .sort();
    expect(keys(en).length).toBeGreaterThan(20);
    expect(keys(tr)).toEqual(keys(en));
    for (const k of keys(tr)) expect(tr[k]).not.toMatch(/[—–]/);
  });
});

describe("the cut sequence's name", () => {
  it("keeps one suffix and counts later passes", () => {
    expect(cutName("Talk", "No Pauses")).toBe("Talk (No Pauses)");
    expect(cutName("Talk (No Pauses)", "No Pauses")).toBe("Talk (No Pauses) 2");
    expect(cutName("Talk (No Pauses) 2", "No Pauses")).toBe("Talk (No Pauses) 3");
    expect(cutName("V2 (Boşluksuz)", "Boşluksuz")).toBe("V2 (Boşluksuz) 2");
  });
});
