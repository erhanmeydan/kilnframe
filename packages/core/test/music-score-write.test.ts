// packages/core/test/music-score-write.test.ts
import { describe, expect, it } from "vitest";
import type { TextProvider, TextRequest } from "../src/providers/types.js";
import {
  lyriaPrompt,
  rewriteSectionPrompt,
  writeMusicPlan,
} from "../src/music/score/write-plan.js";

function fakeProvider(replies: string[]): TextProvider & { requests: TextRequest[] } {
  const requests: TextRequest[] = [];
  return {
    name: "fake",
    model: "fake-1",
    capabilities: { vision: true, structuredOutput: false, contextWindow: 200_000 },
    requests,
    async complete(req) {
      requests.push(structuredClone(req));
      const text = replies.shift();
      if (text === undefined) throw new Error("no more scripted replies");
      return { text, model: "fake-1", usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
}
const transcript = {
  version: 1 as const,
  language: "tr",
  model: "w",
  duration_s: 60,
  text: "a b",
  words: [
    { text: "a", start: 0.5, end: 29.8 },
    { text: "b", start: 30.6, end: 59 },
  ],
};
const section = (o: object) =>
  JSON.stringify({
    title: "Giriş",
    mood: "merak",
    energy: 2,
    tempo: 90,
    prompt: "curious soft piano",
    ...o,
  });

describe("writing the music plan", () => {
  it("asks once, snaps the answer into the pauses and marks the final", async () => {
    const reply = `{"version":1,"world":"warm piano","sections":[${section({ id: "a", startS: 0, endS: 31 })},${section({ id: "b", startS: 31, endS: 60 })}]}`;
    const p = fakeProvider([reply]);
    const plan = await writeMusicPlan({ provider: p, transcript, durationS: 60, language: "tr" });
    expect(plan.sections.map((s) => s.startS)).toEqual([0, 30.2]);
    expect(plan.sections[1]!.final).toBe(true);
    expect(p.requests[0]!.purpose).toBe("music-plan");
    expect(JSON.stringify(p.requests[0]!.messages)).toContain("30.6");
  });

  it("repairs a broken answer once with the problems listed", async () => {
    const p = fakeProvider([
      "not json",
      `{"version":1,"world":"w","sections":[${section({ id: "a", startS: 0, endS: 60 })}]}`,
    ]);
    await writeMusicPlan({ provider: p, transcript, durationS: 60, language: "tr" });
    expect(p.requests).toHaveLength(2);
    expect(JSON.stringify(p.requests[1]!.messages)).toMatch(/Not right yet/);
  });

  it("plans music for a range without speech", async () => {
    const p = fakeProvider([
      `{"version":1,"world":"w","sections":[${section({ id: "a", startS: 0, endS: 40 })}]}`,
    ]);
    const plan = await writeMusicPlan({
      provider: p,
      transcript: null,
      durationS: 40,
      language: "en",
    });
    expect(plan.sections).toHaveLength(1);
    expect(JSON.stringify(p.requests[0]!.messages)).toMatch(/no speech/i);
  });

  it("builds the Lyria text: the world first, instrumental only, mid range open, a final hit", () => {
    const plan = {
      version: 1 as const,
      world: "warm piano, D minor",
      sections: [
        {
          id: "s1",
          title: "T",
          startS: 0,
          endS: 40,
          mood: "m",
          energy: 3 as const,
          tempo: 90,
          prompt: "rising strings",
          final: true,
        },
      ],
    };
    const text = lyriaPrompt(plan, plan.sections[0]!);
    expect(text.indexOf("warm piano")).toBeLessThan(text.indexOf("rising strings"));
    expect(text).toMatch(/instrumental only/i);
    expect(text).toMatch(/300 Hz to 3 kHz/);
    expect(text).toMatch(/single strong final hit/i);
  });

  it("rewrites one section's Lyria text from the editor's note", async () => {
    const p = fakeProvider(['{"prompt":"brighter acoustic guitar"}']);
    const plan = {
      version: 1 as const,
      world: "w",
      sections: [
        {
          id: "s1",
          title: "T",
          startS: 0,
          endS: 40,
          mood: "m",
          energy: 3 as const,
          tempo: 90,
          prompt: "old",
        },
      ],
    };
    expect(
      await rewriteSectionPrompt({ provider: p, plan, sectionId: "s1", note: "daha parlak" }),
    ).toBe("brighter acoustic guitar");
  });
});
