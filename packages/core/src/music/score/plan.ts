// packages/core/src/music/score/plan.ts
// A music plan: one sound world for the whole video and sections per topic. The model gives rough times; the
// code snaps every boundary into a speech pause and makes the sections cover the range without a gap.
import { z } from "zod";
import type { Word } from "../../schemas/transcript.js";

export const MIN_SECTION_S = 20;
export const MAX_SECTION_S = 180;
const MIN_PAUSE_S = 0.4;

export const MusicSectionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(80),
  startS: z.number().min(0),
  endS: z.number().positive(),
  mood: z.string().min(1).max(200),
  energy: z.number().int().min(1).max(5),
  tempo: z.number().min(40).max(200),
  prompt: z.string().min(1).max(1000),
  transitionOut: z.enum(["crossfade", "end"]).optional(),
  silent: z.boolean().optional(),
  final: z.boolean().optional(),
});
export type MusicSection = z.infer<typeof MusicSectionSchema>;

export const MusicPlanSchema = z.object({
  version: z.literal(1),
  world: z.string().min(1).max(400),
  sections: z.array(MusicSectionSchema).min(1),
});
export type MusicPlan = z.infer<typeof MusicPlanSchema>;

/** Middles of the pauses between words that last at least MIN_PAUSE_S. */
function pauses(words: Word[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < words.length; i++) {
    const a = words[i - 1]!.end;
    const b = words[i]!.start;
    if (b - a >= MIN_PAUSE_S) out.push(+((a + b) / 2).toFixed(3));
  }
  return out;
}

export function snapPlan(plan: MusicPlan, words: Word[], durationS: number): MusicPlan {
  let sections = [...plan.sections].sort((a, b) => a.startS - b.startS);
  if (durationS < MIN_SECTION_S * 2 || sections.length === 1) sections = [sections[0]!];
  const gaps = pauses(words);
  const cuts = sections.slice(1).map((s) => {
    const near = gaps.reduce<number | null>(
      (best, g) => (best === null || Math.abs(g - s.startS) < Math.abs(best - s.startS) ? g : best),
      null,
    );
    return near !== null && Math.abs(near - s.startS) <= 15 ? near : s.startS;
  });
  const n = sections.length;
  return {
    ...plan,
    sections: sections.map((s, i) => {
      const last = i === n - 1;
      // only the last section is the final; the model's own marks are replaced
      const { transitionOut, ...rest } = s;
      delete rest.final;
      return {
        ...rest,
        id: `s${i + 1}`,
        startS: i === 0 ? 0 : cuts[i - 1]!,
        endS: last ? +durationS.toFixed(3) : cuts[i]!,
        ...(last ? { final: true } : { transitionOut: transitionOut ?? "crossfade" }),
      };
    }),
  };
}

export function planProblems(plan: MusicPlan, durationS: number): string[] {
  const out: string[] = [];
  const s = plan.sections;
  if (Math.abs(s[0]!.startS) > 0.01) out.push(`The first section does not start at 0.`);
  if (Math.abs(s.at(-1)!.endS - durationS) > 0.05)
    out.push(`The last section must end at ${durationS.toFixed(2)} s.`);
  s.forEach((x, i) => {
    const len = x.endS - x.startS;
    const short = durationS >= MIN_SECTION_S && len < MIN_SECTION_S;
    if (short)
      out.push(
        `Section ${x.id} is ${len.toFixed(1)} s; sections need at least ${MIN_SECTION_S} s.`,
      );
    if (len > MAX_SECTION_S)
      out.push(
        `Section ${x.id} is ${len.toFixed(1)} s; sections may last at most ${MAX_SECTION_S} s.`,
      );
    const next = s[i + 1];
    if (next && Math.abs(next.startS - x.endS) > 0.01)
      out.push(`There is a gap or overlap between ${x.id} and ${next.id}.`);
  });
  return out;
}

export function splitLong(plan: MusicPlan, maxS = MAX_SECTION_S): MusicPlan {
  const out: MusicSection[] = [];
  for (const s of plan.sections) {
    const len = s.endS - s.startS;
    if (len <= maxS) {
      out.push(s);
      continue;
    }
    const parts = Math.ceil(len / maxS);
    for (let k = 0; k < parts; k++) {
      const last = k === parts - 1;
      const { transitionOut, final, ...rest } = s;
      out.push({
        ...rest,
        startS: +(s.startS + (len * k) / parts).toFixed(3),
        endS: +(s.startS + (len * (k + 1)) / parts).toFixed(3),
        ...(last
          ? { ...(transitionOut ? { transitionOut } : {}), ...(final ? { final } : {}) }
          : { transitionOut: "crossfade" as const }),
      });
    }
  }
  return { ...plan, sections: out.map((s, i) => ({ ...s, id: `s${i + 1}` })) };
}
