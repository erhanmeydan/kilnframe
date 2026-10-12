// packages/core/test/music-score-plan.test.ts
import { describe, expect, it } from "vitest";
import {
  planProblems,
  snapPlan,
  splitLong,
  type MusicPlan,
  type MusicSection,
} from "../src/music/score/plan.js";

const sec = (o: Partial<MusicSection> & { startS: number; endS: number }): MusicSection => ({
  id: "x",
  title: "T",
  mood: "calm",
  energy: 2,
  tempo: 90,
  prompt: "soft piano",
  transitionOut: "crossfade",
  ...o,
});
const plan = (sections: MusicSection[]): MusicPlan => ({ version: 1, world: "piano", sections });
const w = (start: number, end: number) => ({ text: "x", start, end });

describe("music plan", () => {
  it("snaps a boundary to the nearest pause of at least 0.4 s and covers the range", () => {
    // words run to 29.8, pause to 30.6, words again: the boundary given as 31 lands in the pause
    const words = [w(0.5, 29.8), w(30.6, 59)];
    const p = snapPlan(
      plan([sec({ startS: 0, endS: 31 }), sec({ startS: 31, endS: 60 })]),
      words,
      60,
    );
    expect(p.sections.map((s) => [s.id, s.startS, s.endS])).toEqual([
      ["s1", 0, 30.2],
      ["s2", 30.2, 60],
    ]);
    expect(p.sections[1]!.final).toBe(true);
    expect(p.sections[1]!.transitionOut).toBeUndefined();
    expect(p.sections[0]!.final).toBeFalsy();
  });

  it("collapses a range shorter than 20 s to one section covering all of it", () => {
    const p = snapPlan(plan([sec({ startS: 0, endS: 6 }), sec({ startS: 6, endS: 14 })]), [], 14);
    expect(p.sections).toHaveLength(1);
    expect([p.sections[0]!.startS, p.sections[0]!.endS]).toEqual([0, 14]);
    expect(planProblems(p, 14)).toEqual([]);
  });

  it("names gaps, overlaps and sections outside 20 to 180 s as problems", () => {
    const bad = plan([sec({ startS: 0, endS: 10 }), sec({ startS: 12, endS: 300 })]);
    const problems = planProblems(bad, 300).join("\n");
    expect(problems).toMatch(/s?1.*20 s/i);
    expect(problems).toMatch(/gap|does not start/i);
    expect(problems).toMatch(/180 s/);
  });

  it("splits a section over 180 s in two with a crossfade between", () => {
    const p = splitLong(
      plan([sec({ startS: 0, endS: 300, transitionOut: undefined, final: true })]),
    );
    expect(p.sections.map((s) => [s.startS, s.endS, s.transitionOut, !!s.final])).toEqual([
      [0, 150, "crossfade", false],
      [150, 300, undefined, true],
    ]);
  });
});
