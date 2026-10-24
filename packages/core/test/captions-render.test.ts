import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCaptionProject, type CaptionDoc } from "../src/captions/compose.js";
import { previewCaptionStill, renderCaptions } from "../src/captions/render.js";
import { CAPTION_LOOKS } from "../src/captions/styles.js";
import type { CaptionLine, CaptionStyleId } from "../src/captions/types.js";
import { ffmpegPath } from "../src/config.js";
import { checkProject, snapshotProject } from "../src/hyperframes.js";

// Real HyperFrames renders take a browser and minutes: run with KILNFRAME_RENDER_TESTS=1.
const RENDER = Boolean(process.env.KILNFRAME_RENDER_TESTS);
const LOOKS: CaptionStyleId[] = ["kil-lacivert", "loud", "bant"];

function line(text: string, start: number, end: number): CaptionLine {
  const parts = text.split(" ");
  const step = (end - start) / parts.length;
  return {
    start,
    end,
    text,
    changed: false,
    words: parts.map((t, i) => ({ text: t, start: start + i * step, end: start + (i + 1) * step })),
  };
}

function doc(lines: CaptionLine[], over: Partial<CaptionDoc> = {}): CaptionDoc {
  return {
    lines,
    language: "tr",
    glossary: [],
    durationS: 10,
    width: 1080,
    height: 1920,
    fps: "25",
    hideSpans: [],
    ...over,
  };
}

/** Rows of the PNG that hold any visible pixel (alpha above a small threshold). */
function opaqueRows(png: string, width: number, height: number): number[] {
  const raw = execFileSync(
    ffmpegPath(),
    [
      "-v",
      "error",
      "-i",
      png,
      "-vf",
      `scale=${width}:${height}`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "pipe:1",
    ],
    { maxBuffer: width * height * 4 + 1024 },
  );
  const rows: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((raw[(y * width + x) * 4 + 3] as number) > 8) {
        rows.push(y);
        break;
      }
    }
  }
  return rows;
}

async function shotsAt(d: CaptionDoc, look: CaptionStyleId, times: number[]): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), "kf-caption-snap-"));
  buildCaptionProject(d, look, CAPTION_LOOKS[look].colors, dir);
  await snapshotProject(dir, times, join(dir, "shots"));
  const index = (f: string) => Number(/^frame-(\d+)/.exec(f)?.[1] ?? 0);
  return readdirSync(join(dir, "shots"))
    .filter((f) => f.endsWith(".png"))
    .sort((a, b) => index(a) - index(b))
    .map((f) => join(dir, "shots", f));
}

function probe(file: string): Record<string, string> {
  const out = execFileSync(join(ffmpegPath(), "..", "ffprobe"), [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=codec_name,profile,pix_fmt:format=duration",
    "-of",
    "default=noprint_wrappers=1",
    file,
  ]).toString();
  return Object.fromEntries(
    out
      .trim()
      .split("\n")
      .map((l) => l.split("=") as [string, string]),
  );
}

const two = doc([
  line("Yapay zekâ ile video üretirken", 0.2, 2.6),
  line("Çünkü elinde bir referans yok.", 3.0, 4.0),
  line("Şimdi ığdır ve göğüs", 6.0, 9.5),
]);

describe.skipIf(!RENDER)("caption render", () => {
  it.each(LOOKS)(
    "passes hyperframes check for %s",
    async (look) => {
      const dir = mkdtempSync(join(tmpdir(), "kf-caption-check-"));
      buildCaptionProject(two, look, CAPTION_LOOKS[look].colors, dir);
      const report = await checkProject(dir);
      expect(report.errors).toEqual([]);
    },
    180_000,
  );

  it.each(LOOKS)(
    "draws %s portrait captions centred at 65-72 %% with the bottom 15 %% empty",
    async (look) => {
      const [shot] = await shotsAt(two, look, [1.5]);
      const rows = opaqueRows(shot as string, 1080, 1920);
      expect(rows.length).toBeGreaterThan(0);
      const centre = ((rows[0] as number) + (rows.at(-1) as number)) / 2 / 1920;
      expect(centre).toBeGreaterThanOrEqual(0.65);
      expect(centre).toBeLessThanOrEqual(0.72);
      expect(rows.at(-1) as number).toBeLessThan(1920 * 0.85);
    },
    180_000,
  );

  it("hides lines inside hidden spans and 0.35 s after the last word", async () => {
    const d = { ...two, hideSpans: [{ startS: 7, endS: 8.5 }] };
    // 3.8: second line on; 4.45: past its 0.35 s hold; 7.5: inside the hidden span; 9.0: back
    const shots = await shotsAt(d, "bant", [3.8, 4.45, 7.5, 9.0]);
    const visible = shots.map((s) => opaqueRows(s, 1080, 1920).length > 0);
    expect(visible).toEqual([true, false, false, true]);
  }, 180_000);

  it("renders a transparent ProRes 4444 clip and an SRT, never overwriting earlier ones", async () => {
    const out = mkdtempSync(join(tmpdir(), "kf-caption-render-"));
    const d = doc(
      [line("Bir iki üç", 0.2, 1.4), line("dört beş altı", 1.6, 2.8), line("yedi sekiz", 3.0, 4.4)],
      { durationS: 5 },
    );
    const first = await renderCaptions({
      doc: d,
      look: "loud",
      colors: CAPTION_LOOKS.loud.colors,
      outDir: out,
    });
    expect(first.video).toBe(join(out, "captions-1.mov"));
    const info = probe(first.video);
    expect(info.codec_name).toBe("prores");
    // written as yuva444p10le; FFmpeg's ProRes 4444 decoder reports it as 12-bit with alpha
    expect(info.profile).toBe("4444");
    expect(info.pix_fmt).toMatch(/^yuva444p1[02]le$/);
    expect(Math.abs(Number(info.duration) - 5)).toBeLessThanOrEqual(1 / 25 + 1e-6);
    const srt = readFileSync(first.srt, "utf8");
    expect(srt.match(/ --> /g)).toHaveLength(3);
    const before = statSync(first.video);

    const second = await renderCaptions({
      doc: d,
      look: "bant",
      colors: CAPTION_LOOKS.bant.colors,
      outDir: out,
    });
    expect(second.video).toBe(join(out, "captions-2.mov"));
    expect(second.srt).toBe(join(out, "captions-2.srt"));
    const after = statSync(first.video);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
  }, 600_000);

  it("makes a still over a frame of the footage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kf-caption-still-"));
    const frame = join(dir, "frame.png");
    execFileSync(ffmpegPath(), [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=0x556070:s=540x960",
      "-frames:v",
      "1",
      frame,
    ]);
    const out = await previewCaptionStill({
      doc: two,
      look: "kil-lacivert",
      colors: CAPTION_LOOKS["kil-lacivert"].colors,
      atS: 1.5,
      frame,
      out: join(dir, "still.png"),
    });
    // laid over an opaque frame, every row has visible pixels
    expect(opaqueRows(out, 1080, 1920)).toHaveLength(1920);
  }, 180_000);
});
