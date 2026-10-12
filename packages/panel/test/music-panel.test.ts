import { describe, expect, it } from "vitest";
import { clock, levelNote, mergeWithNext, planCost, toggleSilent } from "../src/music";

const plan = {
  version: 1 as const,
  world: "w",
  sections: [
    { id: "s1", title: "A", startS: 0, endS: 40, mood: "m", energy: 2, tempo: 90, prompt: "p", transitionOut: "crossfade" as const },
    { id: "s2", title: "B", startS: 40, endS: 70, mood: "m", energy: 2, tempo: 90, prompt: "p", transitionOut: "end" as const },
    { id: "s3", title: "C", startS: 70, endS: 100, mood: "m", energy: 3, tempo: 90, prompt: "p", final: true },
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
    const ok = { id: "s1", file: "f", clean: "c", preview: null, atS: 0, durationS: 40, measured: { speechDb: -21.4, gapDb: -15.2 } };
    expect(levelNote(ok, -21)).toMatchObject({ speech: "-21.4", gap: "-15.2", warn: false });
    expect(levelNote({ ...ok, measured: { speechDb: -18.9, gapDb: -15 } }, -21).warn).toBe(true);
    expect(levelNote({ ...ok, measured: { speechDb: null, gapDb: -15.1 } }, -21)).toMatchObject({ speech: null, warn: false });
  });

  it("shows section times as minutes and seconds", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(95.6)).toBe("1:35");
    expect(clock(3725)).toBe("62:05");
  });
});
