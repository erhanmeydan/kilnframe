import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAPTION_LOOKS,
  correctCaptionWords,
  createTextProvider,
  ffmpegPath,
  previewCaptionStill,
  renderCaptions,
  transcribe,
} from "@kilnframe/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAPTION_LOOK_IDS, MemoryKeyStore, type JobParams } from "../src/index.js";
import {
  captionPreviewFrames,
  captionPreviewRoot,
  clearCaptionPreviews,
  loadCaptionsState,
  saveCaptionsState,
} from "../src/panel-support.js";
import { pipelineRunner } from "../src/runner.js";

// the real still by default; a test makes a look fail (or draw at once) without a browser
vi.mock("@kilnframe/core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@kilnframe/core")>();
  return {
    ...core,
    previewCaptionStill: vi.fn(core.previewCaptionStill),
    transcribe: vi.fn(core.transcribe),
    correctCaptionWords: vi.fn(core.correctCaptionWords),
    createTextProvider: vi.fn(core.createTextProvider),
    renderCaptions: vi.fn(core.renderCaptions),
  };
});

// Whisper and HyperFrames take a model and a browser: run with KILNFRAME_RENDER_TESTS=1.
const SLOW = Boolean(process.env.KILNFRAME_RENDER_TESTS);
const events = { progress: () => {}, signal: new AbortController().signal };

// previews go under the app's own folder: a fresh one per test
let home: string;
const savedHome = process.env.KILNFRAME_HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kf-home-"));
  process.env.KILNFRAME_HOME = home;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.KILNFRAME_HOME;
  else process.env.KILNFRAME_HOME = savedHome;
  vi.mocked(previewCaptionStill).mockReset();
  vi.mocked(transcribe).mockReset();
  vi.mocked(correctCaptionWords).mockReset();
  vi.mocked(createTextProvider).mockReset();
  vi.mocked(renderCaptions).mockReset();
});

const tinyDoc = {
  lines: [
    {
      start: 0,
      end: 0.4,
      text: "Merhaba",
      words: [{ text: "Merhaba", start: 0, end: 0.4 }],
      changed: false,
    },
  ],
  language: "tr",
  glossary: [],
  durationS: 1,
  width: 480,
  height: 270,
  fps: "25",
  hideSpans: [],
};

/** A small PNG where the still would be, as the core writes it. */
function drawPng(out: string): string {
  const r = spawnSync(ffmpegPath(), [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=16x16",
    "-frames:v",
    "1",
    out,
  ]);
  if (r.status !== 0) throw new Error("ffmpeg could not draw the test still");
  return out;
}

function run(params: JobParams): Promise<unknown> {
  return pipelineRunner(new MemoryKeyStore())(params, events);
}

describe("caption jobs", () => {
  it("accepts exactly the looks the core knows", () => {
    expect([...CAPTION_LOOK_IDS].sort()).toEqual(Object.keys(CAPTION_LOOKS).sort());
  });

  it.runIf(SLOW)(
    "says there is no speech in a silent range",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "kf-captions-"));
      const wav = Buffer.alloc(44 + 16000 * 2 * 2);
      wav.write("RIFF", 0);
      wav.writeUInt32LE(wav.length - 8, 4);
      wav.write("WAVEfmt ", 8);
      wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20);
      wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(16000, 24);
      wav.writeUInt32LE(32000, 28);
      wav.writeUInt16LE(2, 32);
      wav.writeUInt16LE(16, 34);
      wav.write("data", 36);
      wav.writeUInt32LE(wav.length - 44, 40);
      const audioPath = join(dir, "silence.wav");
      writeFileSync(audioPath, wav);
      await expect(
        run({
          kind: "captions-text",
          audioPath,
          outDir: join(dir, "out"),
          glossary: [],
          mode: "written",
        }),
      ).rejects.toThrow(/no speech/i);
    },
    300_000,
  );

  it("fails a preview only when no asked look can be drawn, and leaves no files", async () => {
    vi.mocked(previewCaptionStill).mockRejectedValue(new Error("the look could not be drawn"));
    await expect(
      run({ kind: "captions-preview", doc: tinyDoc, looks: ["dinamik", "hap"], atS: 0.2 }),
    ).rejects.toThrow(/could not be drawn/);
    expect(readdirSync(join(captionPreviewRoot(), "runs"))).toEqual([]);
  });

  it("gives null for one look that cannot be drawn and the others' stills all the same", async () => {
    vi.mocked(previewCaptionStill).mockImplementation(async (o) => {
      if (o.look === "hap") throw new Error("the look could not be drawn");
      return drawPng(o.out);
    });
    const r = (await run({
      kind: "captions-preview",
      doc: tinyDoc,
      looks: ["dinamik", "hap"],
      atS: 0.2,
    })) as { images: Record<string, string | null> };
    expect(r.images.dinamik).toMatch(/^data:image\/jpeg;base64,/);
    expect(r.images.hap).toBeNull();
  });

  it("clears what a stopped preview left before the next one runs, and after it", async () => {
    // a preview whose worker was killed never ran its own clean-up
    const stale = join(captionPreviewRoot(), "runs", "killed");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "loud.png"), "x");
    let during: string[] = [];
    vi.mocked(previewCaptionStill).mockImplementation(async (o) => {
      during = readdirSync(join(captionPreviewRoot(), "runs"));
      return drawPng(o.out);
    });
    await run({ kind: "captions-preview", doc: tinyDoc, looks: ["loud"], atS: 0.2 });
    expect(during).not.toContain("killed");
    expect(readdirSync(join(captionPreviewRoot(), "runs"))).toEqual([]);
  });

  it("keeps previews under the app's own folder, emptied when the app starts", () => {
    expect(captionPreviewRoot()).toBe(join(home, "previews", "captions"));
    expect(captionPreviewFrames()).toBe(join(home, "previews", "captions", "frames"));
    mkdirSync(join(captionPreviewRoot(), "frames"), { recursive: true });
    writeFileSync(join(captionPreviewRoot(), "frames", "caption-frame.png"), "x");
    clearCaptionPreviews();
    expect(existsSync(captionPreviewRoot())).toBe(false);
  });

  it("reports the parts a correction could not fix, with the parts it did fix", async () => {
    const heard = [{ text: "merhaba", start: 0, end: 0.4 }];
    const fixed = [{ text: "Merhaba.", start: 0, end: 0.4 }];
    vi.mocked(transcribe).mockResolvedValue({
      language: "tr",
      duration_s: 1,
      words: heard,
    } as never);
    vi.mocked(createTextProvider).mockReturnValue({} as never);
    vi.mocked(correctCaptionWords).mockResolvedValue({
      corrected: true,
      words: fixed,
      error: "1 of 3 parts kept the original text: 429",
    } as never);
    const outDir = mkdtempSync(join(tmpdir(), "kf-text-"));
    const r = await run({
      kind: "captions-text",
      audioPath: "/a.wav",
      outDir,
      glossary: [],
      mode: "written",
      provider: "anthropic",
    });
    expect(r).toMatchObject({
      corrected: true,
      words: fixed,
      original: heard,
      correctionError: "1 of 3 parts kept the original text: 429",
    });
  });

  it("writes the SRT in the sequence's time for an In/Out range", async () => {
    vi.mocked(renderCaptions).mockResolvedValue({
      video: "/j/captions-1.mov",
      srt: "/j/captions-1.srt",
    });
    const r = await run({
      kind: "captions-render",
      doc: tinyDoc,
      look: "bant",
      colors: CAPTION_LOOKS.bant.colors,
      outDir: "/j",
      srtOffsetS: 75.5,
    });
    expect(r).toEqual({
      kind: "captions-render",
      video: "/j/captions-1.mov",
      srt: "/j/captions-1.srt",
    });
    expect(vi.mocked(renderCaptions).mock.calls[0]![0]).toMatchObject({
      outDir: "/j",
      srtOffsetS: 75.5,
    });
  });

  it("keeps the tab's state beside the text job's words in the job folder", () => {
    const jobDir = mkdtempSync(join(tmpdir(), "kf-job-"));
    expect(loadCaptionsState(jobDir)).toBeNull();
    writeFileSync(join(jobDir, "captions.json"), JSON.stringify({ words: [1], language: "tr" }));
    saveCaptionsState(jobDir, { lines: ["a"], look: "loud" });
    saveCaptionsState(jobDir, { lines: ["b"], look: "hap" });
    expect(loadCaptionsState(jobDir)).toEqual({
      words: [1],
      language: "tr",
      panel: { lines: ["b"], look: "hap" },
    });
    // never a folder of its own making
    expect(() => saveCaptionsState(join(jobDir, "gone"), {})).toThrow(/no caption job folder/);
    expect(existsSync(join(jobDir, "gone"))).toBe(false);
  });

  it.runIf(SLOW)(
    "previews each asked look as a small JPEG and deletes the PNGs",
    async () => {
      const word = (text: string, start: number) => ({ text, start, end: start + 0.4 });
      const words = [word("Merhaba", 0), word("dünya", 0.4)];
      const doc = {
        lines: [{ start: 0, end: 0.8, text: "Merhaba dünya", words, changed: false }],
        language: "tr",
        glossary: [],
        durationS: 2,
        width: 1920,
        height: 1080,
        fps: "25",
        hideSpans: [],
      };
      const r = (await run({
        kind: "captions-preview",
        doc,
        looks: ["kil-lacivert", "loud", "dinamik"],
        atS: 0.5,
      })) as { kind: string; images: Record<string, string | null> };
      expect(r.kind).toBe("captions-preview");
      // the panel shows them inline: it cannot read a file by its path
      expect(r.images["kil-lacivert"]).toMatch(/^data:image\/jpeg;base64,/);
      expect(r.images.loud).toMatch(/^data:image\/jpeg;base64,/);
      expect(r.images.dinamik).toMatch(/^data:image\/jpeg;base64,/);
      expect(readdirSync(join(captionPreviewRoot(), "runs"))).toEqual([]);
    },
    300_000,
  );

  it.runIf(SLOW)(
    "renders a short preview clip as frames over the footage",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "kf-captions-"));
      const word = (text: string, start: number) => ({ text, start, end: start + 0.4 });
      const words = [word("Merhaba", 0.2), word("dünya", 0.6)];
      const doc = {
        lines: [{ start: 0.2, end: 1.0, text: "Merhaba dünya", words, changed: false }],
        language: "tr",
        glossary: [],
        durationS: 2.5,
        width: 480,
        height: 270,
        fps: "25",
        hideSpans: [],
      };
      const outDir = join(dir, "preview");
      const r = (await run({
        kind: "captions-render",
        doc,
        look: "bant",
        colors: CAPTION_LOOKS.bant.colors,
        outDir,
        preview: { stills: 6, video: true },
      })) as { frames: string[]; clip: string | null; video?: string };
      expect(r.frames).toHaveLength(6);
      expect(r.clip).toMatch(/^data:video\/mp4;base64,/);
      // a preview leaves nothing behind: no clip, no project, no frames, not even in the job folder
      expect(r.video).toBeUndefined();
      expect(existsSync(outDir)).toBe(false);
      expect(readdirSync(join(captionPreviewRoot(), "runs"))).toEqual([]);
    },
    300_000,
  );
});
