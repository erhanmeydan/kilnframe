import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  captionHtml,
  captionScript,
  captionSegments,
  type CaptionDoc,
} from "../src/captions/compose.js";
import {
  compressedDurationS,
  frameCount,
  framePlan,
  remapScript,
  timelineSpans,
} from "../src/captions/frames.js";
import {
  captionFramePlan,
  captionProgress,
  encodeArgs,
  frameSequence,
  proresEncoders,
} from "../src/captions/render.js";
import { CAPTION_LOOKS } from "../src/captions/styles.js";
import type { CaptionStyleId } from "../src/captions/types.js";

const LOOK_IDS = Object.keys(CAPTION_LOOKS) as CaptionStyleId[];
import type { CaptionLine } from "../src/captions/types.js";

const fps25 = { num: 25, den: 1 };
const ntsc = { num: 30000, den: 1001 };

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

const doc: CaptionDoc = {
  lines: [line("Bir iki üç dört", 0.5, 2.5), line("beş altı yedi", 5, 6.5)],
  language: "tr",
  glossary: [],
  durationS: 12,
  width: 1920,
  height: 1080,
  fps: "25",
  hideSpans: [],
};

describe("timelineSpans", () => {
  it("reads sets as instants and tweens with their duration", () => {
    const spans = timelineSpans(
      `tl.set("#a",{opacity:1},1.000);tl.fromTo("#a",{x:0},{x:1,duration:0.2},2.000);tl.to("#b",{y:1},3.5);`,
    );
    expect(spans).toEqual([
      { startS: 1, endS: 1 },
      { startS: 2, endS: 2.2 },
      { startS: 3.5, endS: 4 },
    ]);
  });

  it("refuses calls it cannot time", () => {
    expect(() => timelineSpans(`tl.to("#a",{x:1,duration:1},"+=1");`)).toThrow(/numeric position/);
    expect(() => timelineSpans(`tl.to("#a",{x:1,duration:1,repeat:2},1);`)).toThrow(/timing/);
    expect(() => timelineSpans(`tl.call(() => {}, [], 1);`)).toThrow(/tl.call/);
  });

  it.each(LOOK_IDS)("follows every call the %s look writes", (look) => {
    const script = captionScript(doc, look, CAPTION_LOOKS[look].colors);
    expect(timelineSpans(script).length).toBeGreaterThan(0);
  });
});

describe("framePlan", () => {
  it("counts frames as HyperFrames does: rounded up", () => {
    expect(frameCount(60, fps25)).toBe(1500);
    expect(frameCount(1.01, fps25)).toBe(26);
    expect(frameCount(1.05, fps25)).toBe(27);
    expect(frameCount(compressedDurationS(658, fps25), fps25)).toBe(658);
    expect(frameCount(compressedDurationS(658, ntsc), ntsc)).toBe(658);
  });

  it("draws the first frame and the frames a change touches, repeating the rest", () => {
    // a set at 1.0 s (frame 25) and a tween 2.0 to 2.2 s (frames 50 to 55) in 4 s at 25 fps
    const plan = framePlan(
      [
        { startS: 1, endS: 1 },
        { startS: 2, endS: 2.2 },
      ],
      4,
      fps25,
    );
    expect(plan.sourceOf).toHaveLength(100);
    const drawn = plan.times.map((t) => Math.round(t * 25));
    expect(drawn[0]).toBe(0);
    expect(drawn).toContain(25);
    for (let f = 50; f <= 55; f++) expect(drawn).toContain(f);
    expect(drawn.length).toBeLessThan(15);
    // a frame between changes shows the last drawn one
    expect(drawn[plan.sourceOf[40] as number]).toBeLessThanOrEqual(40);
    expect(drawn[plan.sourceOf[40] as number]).toBeGreaterThanOrEqual(25);
    expect(drawn[plan.sourceOf[99] as number]).toBeLessThanOrEqual(99);
    // every frame's picture is drawn at or before it, and the mapping never goes back
    plan.sourceOf.forEach((k, f) => {
      expect(Math.round((plan.times[k] as number) * 25)).toBeLessThanOrEqual(f);
      if (f > 0) expect(k).toBeGreaterThanOrEqual(plan.sourceOf[f - 1] as number);
    });
  });

  it("draws a frame for a change that falls between frame times", () => {
    const plan = framePlan([{ startS: 1.013, endS: 1.013 }], 2, fps25);
    const drawn = plan.times.map((t) => Math.round(t * 25));
    expect(drawn).toContain(26);
  });

  it("covers a long recording with far fewer drawn frames than frames", () => {
    const segment = captionSegments(doc, Infinity)[0]!;
    const plan = captionFramePlan(
      { doc, look: "kil-lacivert", colors: CAPTION_LOOKS["kil-lacivert"].colors },
      segment,
      fps25,
    );
    expect(plan.sourceOf).toHaveLength(300);
    expect(plan.times.length).toBeLessThan(150);
  });
});

describe("the compressed composition", () => {
  it("plays the drawn frames one per frame", () => {
    const times = [0, 0.5, 0.54, 3];
    const html = captionHtml(doc, "bant", CAPTION_LOOKS.bant.colors, undefined, {
      times,
      fps: fps25,
    });
    expect(html).toContain(`data-duration="${compressedDurationS(4, fps25)}"`);
    expect(html).toContain("const __times = [0,0.5,0.54,3];");
    expect(html).toContain('window.__timelines["captions"] = __master;');
    expect(html).not.toContain('window.__timelines["captions"] = tl;');
    expect(remapScript(times, fps25)).toContain("k: 3, duration: 0.120000");
  });
});

describe("frameSequence", () => {
  it("links each frame to the picture it shows", () => {
    const dir = mkdtempSync(join(tmpdir(), "kf-seq-"));
    const frames = join(dir, "renders", "frames");
    mkdirSync(frames, { recursive: true });
    for (const n of [1, 2, 3]) writeFileSync(join(frames, `frame_00000${n}.png`), `p${n}`);
    const seq = frameSequence(frames, { times: [0, 0.4, 0.8], sourceOf: [0, 0, 1, 1, 1, 2] });
    const out = join(dir, "renders", "sequence");
    expect(seq.pattern).toBe(join(out, "%07d.png"));
    expect(readdirSync(out).sort()).toHaveLength(6);
    expect(readFileSync(join(out, "0000004.png"), "utf8")).toBe("p2");
    expect(readFileSync(join(out, "0000005.png"), "utf8")).toBe("p3");
    seq.dispose();
    expect(() => readdirSync(out)).toThrow();
  });

  it("refuses when HyperFrames drew fewer frames than planned", () => {
    const dir = mkdtempSync(join(tmpdir(), "kf-seq-"));
    writeFileSync(join(dir, "frame_000001.png"), "x");
    expect(() => frameSequence(dir, { times: [0, 1], sourceOf: [0, 1] })).toThrow(/drew 1/);
  });
});

describe("encoding", () => {
  it("prefers Apple's ProRes on a Mac and FFmpeg's elsewhere", () => {
    expect(proresEncoders("darwin").map((e) => e[1])).toEqual(["prores_videotoolbox", "prores_ks"]);
    expect(proresEncoders("win32").map((e) => e[1])).toEqual(["prores_ks"]);
  });

  it("reads the sequence at the drawn rate and writes the sequence's rate", () => {
    const args = encodeArgs(
      "/s/%07d.png",
      ntsc,
      "30000/1001",
      "/o.mov",
      proresEncoders("win32")[0]!,
    );
    expect(args.slice(args.indexOf("-framerate"), args.indexOf("-framerate") + 4)).toEqual([
      "-framerate",
      "30000/1001",
      "-i",
      "/s/%07d.png",
    ]);
    expect(args[args.indexOf("-r") + 1]).toBe("30000/1001");
    expect(args.at(-1)).toBe("/o.mov");
  });
});

describe("captionProgress", () => {
  it("gives one rising percentage across pieces, drawing and encoding", () => {
    const said: string[] = [];
    const progress = captionProgress(
      [
        { startS: 0, endS: 480 },
        { startS: 480, endS: 720 },
      ],
      (m) => said.push(m),
    );
    progress(0, "draw", 0);
    progress(0, "draw", 1);
    progress(0, "encode", 0.5);
    progress(0, "draw", 0.5); // never goes back
    progress(1, "draw", 0);
    progress(1, "encode", 1);
    expect(said).toEqual([
      "Rendering captions: 0%",
      "Rendering captions: 20%",
      "Rendering captions: 43%",
      "Rendering captions: 66%",
      "Rendering captions: 100%",
    ]);
  });
});
