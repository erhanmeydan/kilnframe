import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDefaults } from "../src/config.js";
import {
  joinParts,
  partsProgress,
  planParts,
  speechProcesses,
  speechThreads,
  type Part,
} from "../src/stages/transcribe-parts.js";
import {
  NoSpeechError,
  readSamples,
  runSpeechParts,
  transcribe,
  type SpeechPartsRequest,
} from "../src/stages/transcribe.js";

const SR = 16_000;
const GB = 1024 ** 3;

/** Speech-like sound (a tone) with silent stretches [from, to) in seconds. */
function sound(seconds: number, quiet: [number, number][] = []): Float32Array {
  const a = new Float32Array(seconds * SR);
  for (let i = 0; i < a.length; i++) {
    const t = i / SR;
    if (!quiet.some(([from, to]) => t >= from && t < to))
      a[i] = 0.3 * Math.sin(2 * Math.PI * 220 * t);
  }
  return a;
}

const contiguous = (parts: Part[], total: number) => {
  expect(parts[0]?.start).toBe(0);
  expect(parts.at(-1)?.end).toBe(total);
  parts.slice(1).forEach((p, i) => expect(p.start).toBe(parts[i]?.end));
};

describe("planParts", () => {
  it("keeps a short recording in one part, read as before", () => {
    const a = sound(60);
    expect(planParts(a, SR)).toEqual([{ start: 0, end: a.length }]);
  });

  it("cuts in the quiet near each target, not inside the speech", () => {
    const a = sound(330, [
      [110, 111],
      [235, 236.2],
    ]);
    const parts = planParts(a, SR);
    contiguous(parts, a.length);
    expect(parts).toHaveLength(3);
    const cuts = parts.slice(1).map((p) => p.start / SR);
    expect(cuts[0]).toBeGreaterThanOrEqual(110);
    expect(cuts[0]).toBeLessThanOrEqual(111);
    expect(cuts[1]).toBeGreaterThanOrEqual(235);
    expect(cuts[1]).toBeLessThanOrEqual(236.2);
  });

  it("covers a recording without any pause, cut near the target", () => {
    const a = sound(400);
    const parts = planParts(a, SR);
    contiguous(parts, a.length);
    for (const p of parts.slice(0, -1)) {
      const len = (p.end - p.start) / SR;
      expect(len).toBeGreaterThanOrEqual(105);
      expect(len).toBeLessThanOrEqual(135);
    }
  });

  it("covers a silent recording whole", () => {
    const a = new Float32Array(400 * SR);
    contiguous(planParts(a, SR), a.length);
  });

  it("never leaves a last part shorter than the minimum", () => {
    const a = sound(260);
    const parts = planParts(a, SR);
    contiguous(parts, a.length);
    const last = parts.at(-1) as Part;
    expect((last.end - last.start) / SR).toBeGreaterThanOrEqual(30);
  });
});

describe("speechProcesses", () => {
  const machine = (gb: number, cores: number) => ({ totalMemoryBytes: gb * GB, cores });

  it("reads with one process on 8 and 16 GB, beside the editor", () => {
    expect(speechProcesses(machine(8, 8), 2100)).toBe(1);
    expect(speechProcesses(machine(16, 10), 2100)).toBe(1);
  });

  it("reads with two from 24 GB up, when the cores allow", () => {
    expect(speechProcesses(machine(32, 12), 2100)).toBe(2);
    expect(speechProcesses(machine(32, 10), 2100)).toBe(1);
    expect(speechProcesses(machine(20, 12), 2100)).toBe(1);
    expect(speechProcesses(machine(24, 12), 2100)).toBe(2);
    expect(speechProcesses(machine(128, 18), 2100)).toBe(2);
    expect(speechProcesses(machine(128, 32), 2100)).toBe(2);
  });

  it("reads a short recording with one", () => {
    expect(speechProcesses(machine(128, 32), 120)).toBe(1);
  });

  it("shares the usable cores out as threads, keeping one process as it was", () => {
    expect(speechThreads(machine(128, 18), 1)).toBeUndefined();
    expect(speechThreads(machine(128, 18), 2)).toBe(6);
    expect(speechThreads(machine(16, 4), 4)).toBe(2);
  });
});

describe("joinParts", () => {
  it("keeps every word of a sentence cut between two parts once, at its time in the recording", () => {
    const parts: Part[] = [
      { start: 0, end: 120 * SR },
      { start: 120 * SR, end: 200 * SR },
    ];
    const words = joinParts(
      parts,
      [
        [
          { text: " Bu", timestamp: [118.2, 118.5] },
          { text: " cümle", timestamp: [118.6, 119.4] },
        ],
        [
          { text: " ikiye", timestamp: [0.3, 0.7] },
          { text: " bölündü", timestamp: [0.8, 1.3] },
          { text: " Prompt", timestamp: [2, 2.4] },
          { text: "'a", timestamp: [2.4, 2.6] },
        ],
      ],
      SR,
    );
    expect(words.map((w) => w.text)).toEqual(["Bu", "cümle", "ikiye", "bölündü", "Prompt'a"]);
    expect(words[2]).toEqual({ text: "ikiye", start: 120.3, end: 120.7 });
    expect(words[4]?.end).toBeCloseTo(122.6);
  });

  it("does not join a part's first chunk to the last word of the part before", () => {
    const parts: Part[] = [
      { start: 0, end: 10 * SR },
      { start: 10 * SR, end: 20 * SR },
    ];
    const words = joinParts(
      parts,
      [[{ text: " son", timestamp: [8, 9] }], [{ text: "ilk", timestamp: [0.5, 1] }]],
      SR,
    );
    expect(words.map((w) => w.text)).toEqual(["son", "ilk"]);
  });

  it("drops words a part invents past its own end", () => {
    const parts: Part[] = [{ start: 0, end: 10 * SR }];
    const words = joinParts(parts, [[{ text: " Altyazı", timestamp: [10.5, 11] }]], SR);
    expect(words).toEqual([]);
  });
});

describe("partsProgress", () => {
  it("reports in 5 percent steps, once each", () => {
    const seen: number[] = [];
    const report = partsProgress((p) => seen.push(p));
    report(0, 100);
    report(3, 100);
    report(41, 100);
    report(42, 100);
    report(100, 100);
    expect(seen).toEqual([0, 40, 100]);
  });
});

describe("readSamples", () => {
  it("reads the exact samples of a part", () => {
    const dir = mkdtempSync(join(tmpdir(), "kf-pcm-"));
    const file = join(dir, "a.f32");
    const a = Float32Array.from({ length: 100 }, (_, i) => i / 100);
    writeFileSync(file, new Uint8Array(a.buffer));
    expect(Array.from(readSamples(file, 10, 13))).toEqual(Array.from(a.subarray(10, 13)));
  });
});

describe("runSpeechParts", () => {
  const dir = mkdtempSync(join(tmpdir(), "kf-parts-"));
  const defaults = loadDefaults();
  /**
   * A stand-in for speech-worker.js in "parts" mode. `onPiece` runs for every piece with `m` (the message),
   * `pieces` (how many this process read) and `send`; by default it answers with one word per part.
   */
  const worker = (
    onPiece = `await send({ type: "piece", index: m.index, chunks: [{ text: " w" + m.index, timestamp: [0.1, 0.4] }] });`,
  ) => {
    const file = join(dir, `w${Math.random().toString(36).slice(2)}.mjs`);
    writeFileSync(
      file,
      `import { appendFileSync } from "node:fs";
const send = (m) => new Promise((r) => process.send(m, undefined, {}, r));
let pieces = 0;
process.once("message", async (req) => {
  appendFileSync(${JSON.stringify(join(dir, "pids"))}, process.pid + "\\n");
  process.on("message", async (m) => {
    if (m.type === "end") process.exit(0);
    if (m.type === "detect") await send({ type: "language", language: "tr", probability: 0.9 });
    if (m.type === "piece") { pieces++; ${onPiece} }
  });
  await send({ type: "progress", message: "Downloading speech model: 100%" });
  await send({ type: "ready" });
});`,
    );
    return file;
  };
  const request: SpeechPartsRequest = {
    kind: "parts",
    defaults,
    pcmPath: "unused",
    sampleRate: SR,
  };
  const parts = (n: number): Part[] =>
    Array.from({ length: n }, (_, i) => ({ start: i * 10 * SR, end: (i + 1) * 10 * SR }));

  it("reads every part in several processes and tells the language once", async () => {
    const seen: string[] = [];
    const r = await runSpeechParts({
      request,
      parts: parts(7),
      processes: 3,
      onProgress: (m) => seen.push(m),
      workerPath: worker(),
    });
    expect(r.language).toBe("tr");
    expect(r.chunks.map((c) => c[0]?.text)).toEqual([
      " w0",
      " w1",
      " w2",
      " w3",
      " w4",
      " w5",
      " w6",
    ]);
    expect(seen.filter((m) => m.startsWith("Language:"))).toEqual(["Language: tr (90%)"]);
    expect(seen.filter((m) => m.startsWith("Downloading"))).toHaveLength(1);
    const percents = seen
      .map((m) => /^Transcribing: (\d+)%$/.exec(m)?.[1])
      .filter((p) => p !== undefined)
      .map(Number);
    expect(percents.at(-1)).toBe(100);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
  });

  it("skips detection when the language is given", async () => {
    const seen: string[] = [];
    const r = await runSpeechParts({
      request,
      parts: parts(2),
      processes: 2,
      language: "en",
      onProgress: (m) => seen.push(m),
      workerPath: worker(),
    });
    expect(r.language).toBe("en");
    expect(seen).not.toContain("Detecting language");
  });

  it("explains a process that crashes, as before, and ends the others", async () => {
    const file = worker(
      `if (m.index === 2) process.exit(9); else await send({ type: "piece", index: m.index, chunks: [] });`,
    );
    await expect(
      runSpeechParts({ request, parts: parts(6), processes: 2, workerPath: file }),
    ).rejects.toThrow(/stopped unexpectedly \(exit 9\).*low on memory/);
  });

  it("keeps the message of a failure a process reports", async () => {
    const file = worker(
      `await send({ type: "failed", name: "Error", message: "Could not download the speech model" });`,
    );
    await expect(
      runSpeechParts({ request, parts: parts(2), processes: 1, workerPath: file }),
    ).rejects.toThrow("Could not download the speech model");
  });

  it("ends every process when stopped", async () => {
    const pids = join(dir, "pids");
    writeFileSync(pids, "");
    const stop = new AbortController();
    // each process reads its first part and then never answers again
    const file = worker(
      `if (pieces === 1) await send({ type: "piece", index: m.index, chunks: [] });`,
    );
    const run = runSpeechParts({
      request,
      parts: parts(8),
      processes: 3,
      onProgress: (m) => {
        if (m.startsWith("Transcribing: ")) setTimeout(() => stop.abort(), 200);
      },
      signal: stop.signal,
      workerPath: file,
    });
    await expect(run).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 500));
    const started = readFileSync(pids, "utf8").trim().split("\n").filter(Boolean).map(Number);
    expect(started.length).toBeGreaterThan(0);
    for (const pid of started) expect(() => process.kill(pid, 0)).toThrow();
  });
});

describe("transcribe in parts", () => {
  const dir = mkdtempSync(join(tmpdir(), "kf-transcribe-"));
  const defaults = loadDefaults();
  /** A 16 kHz mono 16-bit WAV of the given samples. */
  const wav = (samples: Float32Array) => {
    const data = Buffer.alloc(samples.length * 2);
    samples.forEach((s, i) =>
      data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), i * 2),
    );
    const h = Buffer.alloc(44);
    h.write("RIFF", 0);
    h.writeUInt32LE(36 + data.length, 4);
    h.write("WAVEfmt ", 8);
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20);
    h.writeUInt16LE(1, 22);
    h.writeUInt32LE(SR, 24);
    h.writeUInt32LE(SR * 2, 28);
    h.writeUInt16LE(2, 32);
    h.writeUInt16LE(16, 34);
    h.write("data", 36);
    h.writeUInt32LE(data.length, 40);
    const file = join(dir, `a${Math.random().toString(36).slice(2)}.wav`);
    writeFileSync(file, Buffer.concat([h, data]));
    return file;
  };
  /** Answers each piece with a word naming its first sample, so the test sees which part it was. */
  const worker = (chunks: string) => {
    const file = join(dir, `w${Math.random().toString(36).slice(2)}.mjs`);
    writeFileSync(
      file,
      `const send = (m) => new Promise((r) => process.send(m, undefined, {}, r));
process.once("message", async () => {
  process.on("message", async (m) => {
    if (m.type === "end") process.exit(0);
    if (m.type === "detect") await send({ type: "language", language: "tr", probability: 0.99 });
    if (m.type === "piece") await send({ type: "piece", index: m.index, chunks: ${chunks} });
  });
  await send({ type: "ready" });
});`,
    );
    return file;
  };
  const big = { totalMemoryBytes: 128 * GB, cores: 18 };

  it("reads a short recording as one part from its start", async () => {
    const t = await transcribe({
      audioPath: wav(sound(5)),
      defaults,
      machine: big,
      workerPath: worker(`[{ text: " s" + m.start + "-" + m.end, timestamp: [0.5, 1] }]`),
    });
    expect(t.words).toEqual([{ text: `s0-${5 * SR}`, start: 0.5, end: 1 }]);
    expect(t.language).toBe("tr");
  });

  it("reads a long recording in parts and places their words in the whole", async () => {
    const t = await transcribe({
      audioPath: wav(sound(300, [[118, 119.5]])),
      defaults,
      machine: big,
      workerPath: worker(`[{ text: " s" + m.start, timestamp: [1, 2] }]`),
    });
    // 300 s: cut in the pause near 120 s, then near 240 s
    expect(t.words).toHaveLength(3);
    expect(t.words[0]).toEqual({ text: "s0", start: 1, end: 2 });
    const cut = Number(t.words[1]?.text.slice(1)) / SR;
    expect(cut).toBeGreaterThanOrEqual(118);
    expect(cut).toBeLessThanOrEqual(119.5);
    expect(t.words[1]?.start).toBeCloseTo(cut + 1);
    expect(t.duration_s).toBeCloseTo(300);
  });

  it("says no speech for a silent recording", async () => {
    await expect(
      transcribe({
        audioPath: wav(new Float32Array(400 * SR)),
        defaults,
        machine: big,
        workerPath: worker(`[]`),
      }),
    ).rejects.toBeInstanceOf(NoSpeechError);
  });

  it("leaves no temporary audio behind", async () => {
    const before = new Set(
      (await import("node:fs")).readdirSync(tmpdir()).filter((d) => d.startsWith("kf-speech-")),
    );
    await transcribe({
      audioPath: wav(sound(5)),
      defaults,
      machine: big,
      workerPath: worker(`[{ text: " a", timestamp: [0, 1] }]`),
    });
    const after = (await import("node:fs"))
      .readdirSync(tmpdir())
      .filter((d) => d.startsWith("kf-speech-") && !before.has(d));
    expect(after.filter((d) => existsSync(join(tmpdir(), d)))).toEqual([]);
  });
});
