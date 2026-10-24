import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

  it.runIf(SLOW)(
    "previews one PNG per asked look",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "kf-captions-"));
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
        looks: ["kil-lacivert", "loud"],
        atS: 0.5,
        outDir: dir,
      })) as { kind: string; stills: Record<string, string> };
      expect(r.kind).toBe("captions-preview");
      expect(Object.keys(r.stills).sort()).toEqual(["kil-lacivert", "loud"]);
      for (const png of Object.values(r.stills)) {
        expect(existsSync(png)).toBe(true);
        expect(readFileSync(png).subarray(1, 4).toString()).toBe("PNG");
      }
    },
    300_000,
  );
});
