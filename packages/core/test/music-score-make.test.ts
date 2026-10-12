// packages/core/test/music-score-make.test.ts
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SR, readAudio, writeAudio } from "../src/music/score/audio-io.js";
import { meterLevelDb } from "../src/music/score/levels.js";
import { makeScore } from "../src/music/score/make.js";
import type { MusicPlan } from "../src/music/score/plan.js";

/** A fake Lyria: answers with a WAV of `seconds` of tone, a hit near the end when the prompt asks for one. */
function fakeLyria(seconds = 60) {
  const calls: string[] = [];
  const fetchFn = (async (_u: unknown, init?: { body?: string }) => {
    const prompt = String(JSON.parse(init?.body ?? "{}").input ?? "");
    calls.push(prompt);
    const dir = mkdtempSync(join(tmpdir(), "kf-lyria-"));
    const x = new Float32Array(seconds * SR);
    for (let i = 0; i < x.length; i++) x[i] = 0.1 * Math.sin((2 * Math.PI * 220 * i) / SR);
    if (/final hit/i.test(prompt))
      for (let i = (seconds - 8) * SR; i < x.length; i++) {
        const t = i / SR - (seconds - 8);
        x[i]! += 0.8 * Math.exp(-t * 3) * Math.sin(2 * Math.PI * 60 * t);
      }
    writeAudio(join(dir, "a.wav"), [x, x.slice()]);
    const b64 = readFileSync(join(dir, "a.wav")).toString("base64");
    return new Response(
      JSON.stringify({
        steps: [{ content: [{ type: "audio", data: b64, mime_type: "audio/wav" }] }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}
const plan: MusicPlan = {
  version: 1,
  world: "warm piano",
  sections: [
    {
      id: "s1",
      title: "A",
      startS: 0,
      endS: 40,
      mood: "m",
      energy: 2,
      tempo: 90,
      prompt: "calm",
      transitionOut: "crossfade",
    },
    {
      id: "s2",
      title: "B",
      startS: 40,
      endS: 80,
      mood: "m",
      energy: 4,
      tempo: 100,
      prompt: "rising",
      final: true,
    },
  ],
};
const words = [
  { text: "a", start: 1, end: 15 },
  { text: "b", start: 22, end: 39 },
  { text: "c", start: 41, end: 78.5 },
];
const base = (outDir: string, fetchFn: typeof fetch) => ({
  plan,
  words,
  rangeDurationS: 80,
  speechFile: null,
  outDir,
  slider: -21,
  apiKey: "k",
  endpoint: "https://example.test",
  model: "lyria-3.5",
  clipModel: "lyria-3-clip-preview",
  fetch: fetchFn,
});

// each test makes whole scores through ffmpeg: slow on CI's Windows machine
describe("making the score", { timeout: 30_000 }, () => {
  it("writes one ducked clip per section that meet exactly and cover the range", async () => {
    const out = mkdtempSync(join(tmpdir(), "kf-score-"));
    const { fetchFn } = fakeLyria();
    const r = await makeScore(base(out, fetchFn));
    expect(r.sections.map((s) => [s.id, s.atS, +s.durationS.toFixed(3)])).toEqual([
      ["s1", 0, 40],
      ["s2", 40, 40],
    ]);
    for (const s of r.sections) expect(existsSync(s.file!)).toBe(true);
    expect(r.priceUsd).toBeCloseTo(0.16);
    expect(JSON.parse(readFileSync(r.record, "utf8")).sections).toHaveLength(2);
  });

  it("puts the music at the slider under speech and 6 dB higher in a gap", async () => {
    const out = mkdtempSync(join(tmpdir(), "kf-score-"));
    const r = await makeScore(base(out, fakeLyria().fetchFn));
    const s1 = readAudio(r.sections[0]!.file!);
    expect(meterLevelDb(s1, SR, 3, 13)).toBeCloseTo(-21, 0);
    expect(meterLevelDb(s1, SR, 16, 21)).toBeCloseTo(-15, 0);
    expect(r.sections[0]!.measured.speechDb).toBeCloseTo(-21, 0);
  });

  it("regenerates one section without asking Lyria for its neighbour, and they still meet", async () => {
    const out = mkdtempSync(join(tmpdir(), "kf-score-"));
    const first = fakeLyria();
    await makeScore(base(out, first.fetchFn));
    const again = fakeLyria();
    const r = await makeScore({ ...base(out, again.fetchFn), only: ["s2"] });
    expect(again.calls).toHaveLength(1);
    expect(r.sections[0]!.durationS + r.sections[0]!.atS).toBeCloseTo(r.sections[1]!.atS, 3);
  });

  it("writes a section made again under a new name, leaving the placed file as it was", async () => {
    const out = mkdtempSync(join(tmpdir(), "kf-score-"));
    const first = await makeScore(base(out, fakeLyria().fetchFn));
    const before = readFileSync(first.sections[1]!.file!);
    const again = await makeScore({ ...base(out, fakeLyria(70).fetchFn), only: ["s2"] });
    expect(again.sections[1]!.file).not.toBe(first.sections[1]!.file);
    expect(again.sections[1]!.file).toMatch(/s2-2\.wav$/);
    expect(readFileSync(first.sections[1]!.file!).equals(before)).toBe(true);
    // the neighbour was re-cut too: it gets a new name as well, so nothing on the timeline changes under the editor
    expect(again.sections[0]!.file).toMatch(/s1-2\.wav$/);
  });

  it("ends the music on the piece's own close at the last frame, with no separate hit", async () => {
    const out = mkdtempSync(join(tmpdir(), "kf-score-"));
    const lyria = fakeLyria();
    const r = await makeScore(base(out, lyria.fetchFn));
    expect(lyria.calls).toHaveLength(2);
    expect(lyria.calls.some((c) => /lyria-3-clip|final hit/i.test(c))).toBe(false);
    const last = readAudio(r.sections[1]!.file!);
    expect(last[0]!.length / SR).toBeCloseTo(40, 3);
    expect(Math.abs(last[0]!.at(-1)!)).toBeLessThan(0.01);
  });

  it("keeps going when one section fails and turns its neighbour's crossfade into an ending", async () => {
    const out = mkdtempSync(join(tmpdir(), "kf-score-"));
    let n = 0;
    const flaky = (async (u: unknown, init?: { body?: string }) => {
      if (++n <= 3 && /rising/.test(String(init?.body))) return new Response("{}", { status: 400 });
      return fakeLyria().fetchFn(u as never, init as never);
    }) as unknown as typeof fetch;
    const r = await makeScore(base(out, flaky));
    expect(r.sections[1]!.error).toBeTruthy();
    expect(r.sections[0]!.durationS).toBeCloseTo(40, 3);
  });
});
