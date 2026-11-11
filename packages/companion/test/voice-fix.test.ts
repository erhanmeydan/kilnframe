import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSpeechProvider,
  ffmpegPath,
  NoSpeechError,
  pcmWav,
  transcribe,
  wavPcm,
  type SpeechRequest,
} from "@kilnframe/core";
import type * as Core from "@kilnframe/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { ClientMessageSchema, JobParamsSchema, MemoryKeyStore } from "../src/index.js";
import { voiceSampleFile } from "../src/panel-support.js";
import { pipelineRunner } from "../src/runner.js";
import { startCompanion, type Companion } from "../src/server.js";

vi.mock("@kilnframe/core", async (importOriginal) => {
  const core = await importOriginal<typeof Core>();
  return {
    ...core,
    transcribe: vi.fn(core.transcribe),
    createSpeechProvider: vi.fn(core.createSpeechProvider),
  };
});

const events = { progress: () => {}, signal: new AbortController().signal };
const dir = () => mkdtempSync(join(tmpdir(), "kf-vfix-"));

beforeEach(() => {
  vi.mocked(transcribe).mockReset();
  vi.mocked(createSpeechProvider).mockReset();
});

describe("voice fix protocol", () => {
  it("accepts the two job kinds", () => {
    expect(
      JobParamsSchema.safeParse({
        kind: "voice-fix-read",
        audioPath: "/a/window.wav",
        fixStartS: 10,
        fixEndS: 14,
        outDir: "/a",
      }).success,
    ).toBe(true);
    expect(
      JobParamsSchema.safeParse({
        kind: "voice-fix-say",
        text: "Merhaba",
        voice: "abc",
        before: "Önce.",
        outDir: "/a",
        take: 2,
      }).success,
    ).toBe(true);
    for (const bad of [{ take: 0 }, { take: 1.5 }, { text: "" }, { text: "x".repeat(5001) }]) {
      expect(
        JobParamsSchema.safeParse({
          kind: "voice-fix-say",
          text: "Merhaba",
          voice: "abc",
          outDir: "/a",
          take: 1,
          ...bad,
        }).success,
      ).toBe(false);
    }
  });

  it("takes speech.clone with a range or with spans, never both or neither", () => {
    const base = { type: "speech.clone", audioPath: "/a/window.wav", name: "V", consent: true };
    const parse = (o: object) => ClientMessageSchema.safeParse({ ...base, ...o }).success;
    expect(parse({ rangeStartS: 1, rangeEndS: 5 })).toBe(true);
    expect(parse({ spans: [{ startS: 1, endS: 5 }] })).toBe(true);
    expect(parse({ spans: [{ startS: 1, endS: 5 }], dryRun: true })).toBe(true);
    expect(parse({ rangeStartS: 1, rangeEndS: 5, spans: [{ startS: 1, endS: 5 }] })).toBe(false);
    expect(parse({})).toBe(false);
    expect(parse({ rangeStartS: 1 })).toBe(false);
    expect(parse({ spans: [] })).toBe(false);
    expect(parse({ spans: [{ startS: 1, endS: 5 }], consent: false })).toBe(false);
  });

  it("needs consent for a real clone but not for a dry run", () => {
    const msg = {
      type: "speech.clone",
      audioPath: "/a/window.wav",
      name: "V",
      spans: [{ startS: 1, endS: 5 }],
    };
    const parse = (o: object) => ClientMessageSchema.safeParse({ ...msg, ...o }).success;
    expect(parse({ dryRun: true })).toBe(true);
    expect(parse({})).toBe(false);
    expect(parse({ dryRun: false })).toBe(false);
    expect(parse({ consent: true })).toBe(true);
  });

  it("takes both window ends of voice-fix-read or neither", () => {
    const base = {
      kind: "voice-fix-read",
      audioPath: "/a/export.wav",
      fixStartS: 200,
      fixEndS: 203,
      outDir: "/a/voice-fix",
    };
    const parse = (o: object) => JobParamsSchema.safeParse({ ...base, ...o }).success;
    expect(parse({ windowStartS: 20, windowEndS: 383 })).toBe(true);
    expect(parse({ windowStartS: 20 })).toBe(false);
    expect(parse({ windowEndS: 383 })).toBe(false);
    expect(parse({ windowStartS: 50, windowEndS: 40 })).toBe(false);
  });
});

describe("voice sample file", () => {
  it("goes next to audio in a voice-fix folder, else into a voice-fix folder beside it", () => {
    // join: the companion writes Windows paths with backslashes
    const sample = join("/j", "voice-fix", "voice-sample.wav");
    expect(voiceSampleFile(join("/j", "voice-fix", "window.wav"))).toBe(sample);
    expect(voiceSampleFile(join("/j", "other.wav"))).toBe(sample);
  });
});

describe("voice-fix-read", () => {
  const params = (outDir: string) =>
    JobParamsSchema.parse({
      kind: "voice-fix-read",
      audioPath: "/a/window.wav",
      fixStartS: 5,
      fixEndS: 8,
      outDir,
    });

  it("surfaces the no-speech message for a silent window", async () => {
    vi.mocked(transcribe).mockRejectedValue(new NoSpeechError());
    await expect(pipelineRunner(new MemoryKeyStore())(params(dir()), events)).rejects.toThrow(
      /No speech was found/,
    );
  });

  it("returns the text, its context and the clone sample spans", async () => {
    const words = [
      { text: "Önce.", start: 0, end: 1 },
      { text: "Yanlış", start: 5, end: 6 },
      { text: "kelime.", start: 6, end: 7.5 },
      { text: "Sonra.", start: 12, end: 13 },
    ];
    vi.mocked(transcribe).mockResolvedValue({ language: "tr", duration_s: 14, words } as never);
    const outDir = dir();
    const r = (await pipelineRunner(new MemoryKeyStore())(params(outDir), events)) as {
      kind: string;
      text: string;
      before: string;
      after: string;
      language: string;
      sample: { spans: unknown[]; speechS: number };
    };
    expect(r).toMatchObject({
      kind: "voice-fix-read",
      text: "Yanlış kelime.",
      before: "Önce.",
      after: "Sonra.",
      language: "tr",
    });
    expect(r.sample.spans).toEqual([
      { startS: 0, endS: 1 },
      { startS: 12, endS: 13 },
    ]);
    expect(r.sample.speechS).toBeCloseTo(2, 3);
    expect(existsSync(join(outDir, "transcript.json"))).toBe(true);
    expect(r).not.toHaveProperty("windowPath");
  });

  it("reads the window in the language of the part being fixed", async () => {
    const job = dir();
    const audioPath = join(job, "export.wav");
    writeFileSync(audioPath, pcmWav(Buffer.alloc(20 * 8000 * 2), 8000));
    vi.mocked(transcribe)
      .mockResolvedValueOnce({ language: "tr", duration_s: 3, words: [] } as never)
      .mockResolvedValueOnce({
        language: "tr",
        duration_s: 20,
        words: [{ text: "Yanlış.", start: 5, end: 6 }],
      } as never);
    await pipelineRunner(new MemoryKeyStore())(
      JobParamsSchema.parse({
        kind: "voice-fix-read",
        audioPath,
        fixStartS: 5,
        fixEndS: 8,
        outDir: join(job, "voice-fix"),
      }),
      events,
    );
    const calls = vi.mocked(transcribe).mock.calls;
    expect(calls[0]?.[0].audioPath).toBe(join(job, "voice-fix", "fix.wav"));
    expect(calls[1]?.[0]).toMatchObject({ audioPath, language: "tr" });
  });

  it("cuts the window out of a longer export, reads only it, and counts times from its start", async () => {
    const job = dir();
    const exportFile = join(job, "export.wav");
    // 30 s of silence at 8 kHz stands in for the whole sequence's export
    writeFileSync(exportFile, pcmWav(Buffer.alloc(30 * 8000 * 2), 8000));
    // the words as Whisper hears them in the window (which starts 10 s into the export)
    const words = [
      { text: "Önce.", start: 0, end: 1 },
      { text: "Yanlış", start: 5, end: 6 },
      { text: "kelime.", start: 6, end: 7.5 },
      { text: "Sonra.", start: 12, end: 13 },
    ];
    vi.mocked(transcribe).mockResolvedValue({ language: "tr", duration_s: 14, words } as never);
    const outDir = join(job, "voice-fix");
    const r = (await pipelineRunner(new MemoryKeyStore())(
      JobParamsSchema.parse({
        kind: "voice-fix-read",
        audioPath: exportFile,
        fixStartS: 15,
        fixEndS: 18,
        windowStartS: 10,
        windowEndS: 24,
        outDir,
      }),
      events,
    )) as { text: string; windowPath: string; sample: { spans: unknown[] } };
    const windowPath = join(outDir, "window.wav");
    expect(r.windowPath).toBe(windowPath);
    expect(existsSync(windowPath)).toBe(true);
    // the first read is the fixed part alone (its language), the second the whole window
    expect(vi.mocked(transcribe).mock.calls[0]![0]).toMatchObject({
      audioPath: join(outDir, "fix.wav"),
    });
    expect(vi.mocked(transcribe).mock.calls[1]![0]).toMatchObject({
      audioPath: windowPath,
      language: "tr",
    });
    // the fix 15 to 18 s in the export is 5 to 8 s in the window
    expect(r.text).toBe("Yanlış kelime.");
    expect(r.sample.spans).toEqual([
      { startS: 0, endS: 1 },
      { startS: 12, endS: 13 },
    ]);
  });
});

describe("voice-fix-say", () => {
  it("reads the exact text with context, no style, into take-<n>.wav", async () => {
    const seen: SpeechRequest[] = [];
    vi.mocked(createSpeechProvider).mockReturnValue({
      id: "elevenlabs",
      model: "eleven_multilingual_v2",
      synthesize: async (req: SpeechRequest) => {
        seen.push(req);
        return {
          pcm: Buffer.alloc(24000 * 2),
          sampleRate: 24000,
          audioTokens: 0,
          inputTokens: 0,
          characters: req.text.length,
        };
      },
    });
    const keys = new MemoryKeyStore();
    await keys.set("elevenlabs", "xi-test");
    const outDir = join(dir(), "voice-fix");
    const r = (await pipelineRunner(keys)(
      JobParamsSchema.parse({
        kind: "voice-fix-say",
        text: "Doğru kelime",
        voice: "v1",
        before: "Önce.",
        after: "Sonra.",
        language: "tr",
        outDir,
        take: 2,
      }),
      events,
    )) as { kind: string; file: string; durationS: number; priceUsd: number };
    expect(r.kind).toBe("voice-fix-say");
    expect(r.file).toBe(join(outDir, "take-2.wav"));
    expect(r.durationS).toBeCloseTo(1, 2);
    expect(typeof r.priceUsd).toBe("number");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      text: "Doğru kelime",
      voice: "v1",
      language: "tr",
      previousText: "Önce.",
      nextText: "Sonra.",
    });
    expect(seen[0]!.style).toBeUndefined();
    expect(wavPcm(readFileSync(r.file)).sampleRate).toBe(48000);
    expect(vi.mocked(createSpeechProvider).mock.calls[0]![1]).toMatchObject({
      provider: "elevenlabs",
      apiKey: "xi-test",
    });
  });
});

describe("speech.clone dry run and audio.play", () => {
  let companion: Companion;
  afterEach(async () => {
    await companion?.close();
  });
  const TOKEN = "t".repeat(64);

  async function open(o: Partial<Parameters<typeof startCompanion>[0]> = {}) {
    companion = await startCompanion({
      token: TOKEN,
      keys: new MemoryKeyStore(),
      version: "test",
      port: 0,
      runner: async () => ({}),
      ...o,
    });
    const ws = new WebSocket(`ws://127.0.0.1:${companion.port}`);
    const messages: { type: string; [k: string]: unknown }[] = [];
    ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
    await new Promise((r) => ws.once("open", r));
    const next = async (f: (m: { type: string }) => boolean) => {
      for (let i = 0; i < 200; i++) {
        const m = messages.find(f);
        if (m) return m;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("no message: " + JSON.stringify(messages));
    };
    ws.send(JSON.stringify({ type: "hello", token: TOKEN }));
    await next((m) => m.type === "ready");
    return { ws, next };
  }

  it("plays the voice fix takes and the sample, nothing else", async () => {
    const played: string[] = [];
    const { ws, next } = await open({ playAudio: (f) => played.push(f) });
    for (const file of [
      "/Users/e/Movies/Kilnframe/P/job/voice-fix/take-3.wav",
      "C:\\Users\\e\\job\\voice-fix\\voice-sample.wav",
    ]) {
      ws.send(JSON.stringify({ type: "audio.play", file }));
    }
    await next((m) => m.type === "audio.played");
    await new Promise((r) => setTimeout(r, 50));
    expect(played).toHaveLength(2);
    ws.send(JSON.stringify({ type: "audio.play", file: "/etc/voice-fix/take-x.wav" }));
    ws.send(JSON.stringify({ type: "audio.play", file: "/job/voice-fix/other.wav" }));
    await next((m) => m.type === "error");
    await new Promise((r) => setTimeout(r, 50));
    expect(played).toHaveLength(2);
    ws.close();
  });

  it("passes spans and the dry run flag to cloneVoice and returns the sample path", async () => {
    const calls: unknown[] = [];
    const { ws, next } = await open({
      cloneVoice: async (o) => {
        calls.push(o);
        return {
          voice: "",
          name: o.name,
          durationS: 42,
          requiresVerification: false,
          sample: "/j/voice-fix/voice-sample.wav",
        };
      },
    });
    ws.send(
      JSON.stringify({
        type: "speech.clone",
        audioPath: "/j/voice-fix/window.wav",
        spans: [{ startS: 1, endS: 31 }],
        name: "Kilnframe: P",
        dryRun: true,
        consent: true,
      }),
    );
    const m = (await next((x) => x.type === "speech.cloned")) as unknown as {
      sample: string;
      durationS: number;
    };
    expect(m.sample).toBe("/j/voice-fix/voice-sample.wav");
    expect(calls[0]).toMatchObject({ spans: [{ startS: 1, endS: 31 }], dryRun: true });
    ws.close();
  });
});

describe("main cloneVoice with spans (ffmpeg)", () => {
  it("is exercised end to end through cutVoiceSample elsewhere", () => {
    // ffmpeg must exist for the narrate test above
    expect(spawnSync(ffmpegPath(), ["-version"]).status).toBe(0);
    expect(pcmWav(Buffer.alloc(2), 8000).length).toBe(46);
  });
});
