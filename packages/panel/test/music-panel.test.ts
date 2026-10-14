import { describe, expect, it } from "vitest";
import {
  afterMake,
  textSpend,
  musicAct,
  clock,
  levelNote,
  musicBox,
  mergeWithNext,
  newMusic,
  planCost,
  toggleSilent,
  watchesSequence,
} from "../src/music";

const plan = {
  version: 1 as const,
  world: "w",
  sections: [
    {
      id: "s1",
      title: "A",
      startS: 0,
      endS: 40,
      mood: "m",
      energy: 2,
      tempo: 90,
      prompt: "p",
      transitionOut: "crossfade" as const,
    },
    {
      id: "s2",
      title: "B",
      startS: 40,
      endS: 70,
      mood: "m",
      energy: 2,
      tempo: 90,
      prompt: "p",
      transitionOut: "end" as const,
    },
    {
      id: "s3",
      title: "C",
      startS: 70,
      endS: 100,
      mood: "m",
      energy: 3,
      tempo: 90,
      prompt: "p",
      final: true,
    },
  ],
};

describe("music panel", () => {
  it("prices only the sections with music", () => {
    expect(planCost(plan, 0.08)).toBeCloseTo(0.24);
    expect(planCost(toggleSilent(plan, "s2"), 0.08)).toBeCloseTo(0.16);
    expect(toggleSilent(toggleSilent(plan, "s2"), "s2").sections[1]!.silent).toBe(false);
  });

  it("merges a section into the next one, keeping the next one's ending", () => {
    const m = mergeWithNext(plan, "s2");
    expect(m.sections.map((s) => [s.id, s.startS, s.endS, !!s.final])).toEqual([
      ["s1", 0, 40, false],
      ["s2", 40, 100, true],
    ]);
    expect(mergeWithNext(plan, "s3")).toEqual(plan);
  });

  it("warns when a measured level misses its target by more than 1.5 dB", () => {
    const ok = {
      id: "s1",
      file: "f",
      clean: "c",
      preview: null,
      atS: 0,
      durationS: 40,
      measured: { speechDb: -21.4, gapDb: -15.2 },
    };
    expect(levelNote(ok, -21)).toMatchObject({ speech: "-21.4", gap: "-15.2", warn: false });
    expect(levelNote({ ...ok, measured: { speechDb: -18.9, gapDb: -15 } }, -21).warn).toBe(true);
    expect(levelNote({ ...ok, measured: { speechDb: null, gapDb: -15.1 } }, -21)).toMatchObject({
      speech: null,
      warn: false,
    });
  });

  it("shows section times as minutes and seconds", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(95.6)).toBe("1:35");
    expect(clock(3725)).toBe("62:05");
  });

  it("offers to place again after a section was made again, on a new track", () => {
    const st = {
      ...newMusic(),
      plan,
      stage: "making" as const,
      placedTrack: 1,
      edits: { s2: "brighter", s3: "keep" },
    };
    const made = [
      {
        id: "s2",
        file: "/j/music/s2-2.wav",
        clean: null,
        preview: null,
        atS: 40,
        durationS: 30,
        measured: { speechDb: null, gapDb: null },
      },
    ];
    afterMake(st, { sections: made, priceUsd: 0.08, plan }, ["s2"]);
    expect(st.stage).toBe("listen");
    expect(st.placedTrack).toBeNull();
    expect(st.spent).toBeCloseTo(0.08);
    // the note that made s2 again is used up; the other note waits for its own remake
    expect(st.edits).toEqual({ s3: "keep" });
  });

  it("counts the text model's price in the music spend when it is paid by API, not on a plan", () => {
    const st = { ...newMusic(), stage: "making" as const };
    afterMake(st, { sections: [], priceUsd: 0.08, textPriceUsd: 0.02, billing: "api" }, []);
    expect(st.spent).toBeCloseTo(0.1);
    afterMake(st, { sections: [], priceUsd: 0.08, textPriceUsd: 0.02, billing: "plan" }, []);
    expect(st.spent).toBeCloseTo(0.18);
    expect(textSpend({ listPriceUsd: 0.03, billing: "api" })).toBeCloseTo(0.03);
    expect(textSpend({ listPriceUsd: 0.03, billing: "plan" })).toBe(0);
  });

  it("looks for a new In/Out while the range tab or the Music tab's first screen is open", () => {
    expect(watchesSequence("range", "idle")).toBe(true);
    expect(watchesSequence("music", "idle")).toBe(true);
    // a plan or a listen screen belongs to the range it was made for
    expect(watchesSequence("music", "plan")).toBe(false);
    expect(watchesSequence("music", "listen")).toBe(false);
    expect(watchesSequence("story", "idle")).toBe(false);
  });

  it("stops a running music job from its busy screen", () => {
    const sent: unknown[] = [];
    const ctx = { send: (m: unknown) => sent.push(m), render: () => undefined } as never;
    const st = { ...newMusic(), stage: "making" as const, jobId: "job-7" };
    expect(musicAct(st, ctx, "music-cancel", "")).toBe(true);
    expect(sent).toEqual([{ type: "job.cancel", jobId: "job-7" }]);
  });

  it("leaves an action that is not its own, such as the settings' music level, to the panel", () => {
    const ctx = { send: () => undefined, render: () => undefined } as never;
    expect(musicAct(newMusic(), ctx, "music-level", "-18")).toBe(false);
  });

  it("says when making a section again failed and its earlier music stays", () => {
    const st = {
      ...newMusic(),
      plan,
      stage: "listen" as const,
      made: [
        {
          id: "s1",
          file: "/j/music/s1.wav",
          clean: null,
          preview: null,
          atS: 0,
          durationS: 40,
          measured: { speechDb: null, gapDb: null },
          error: "Lyria failed",
        },
      ],
    };
    const ctx = { esc: (x: string) => x, slider: () => -21 } as never;
    expect(musicBox(st, ctx)).toMatch(/earlier music stays|önceki müzik kaldı/);
  });

  it("starts one plan and one placement only, however often the button is clicked", () => {
    let reads = 0;
    const ctx = {
      readSequence: () => {
        reads++;
        return new Promise(() => undefined); // still reading
      },
      render: () => undefined,
    } as never;
    const st = newMusic();
    musicAct(st, ctx, "music-plan", "");
    musicAct(st, ctx, "music-plan", "");
    expect(reads).toBe(1);
    const listen = { ...newMusic(), plan, stage: "listen" as const, made: [] };
    musicAct(listen, ctx, "music-place", "");
    musicAct(listen, ctx, "music-place", "");
    expect(reads).toBe(2);
  });
});
