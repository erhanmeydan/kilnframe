import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPTION_LOOKS } from "@kilnframe/core";
import { describe, expect, it } from "vitest";
import { CAPTION_LOOK_IDS, MemoryKeyStore, type JobParams } from "../src/index.js";
import { pipelineRunner } from "../src/runner.js";

// Whisper and HyperFrames take a model and a browser: run with KILNFRAME_RENDER_TESTS=1.
const SLOW = Boolean(process.env.KILNFRAME_RENDER_TESTS);
const events = { progress: () => {}, signal: new AbortController().signal };

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
    const dir = mkdtempSync(join(tmpdir(), "kf-captions-"));
    const outDir = join(dir, "preview");
    const word = { text: "Merhaba", start: 0, end: 0.4 };
    await expect(
      run({
        kind: "captions-preview",
        doc: {
          lines: [{ start: 0, end: 0.4, text: "Merhaba", words: [word], changed: false }],
          language: "tr",
          glossary: [],
          durationS: 1,
          width: 480,
          height: 270,
          fps: "25",
          hideSpans: [],
        },
        looks: ["dinamik", "hap"],
        atS: 0.2,
        outDir,
      }),
    ).rejects.toThrow(/not available/);
    expect(existsSync(outDir)).toBe(false);
  });

  it.runIf(SLOW)(
    "previews each asked look as a small JPEG, null for a look that cannot be drawn, and deletes the PNGs",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "kf-captions-"));
      const outDir = join(dir, "preview");
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
        outDir,
      })) as { kind: string; images: Record<string, string | null> };
      expect(r.kind).toBe("captions-preview");
      // the panel shows them inline: it cannot read a file by its path
      expect(r.images["kil-lacivert"]).toMatch(/^data:image\/jpeg;base64,/);
      expect(r.images.loud).toMatch(/^data:image\/jpeg;base64,/);
      // one look that cannot be drawn does not sink the others
      expect(r.images.dinamik).toBeNull();
      expect(existsSync(outDir)).toBe(false);
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
      // a preview leaves nothing behind: no clip, no project, no frames
      expect(r.video).toBeUndefined();
      expect(existsSync(outDir)).toBe(false);
    },
    300_000,
  );
});
