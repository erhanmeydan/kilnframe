import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseImageStream, prepareAssets, readAssets } from "../src/assets.js";
import { ffmpegPath } from "../src/config.js";
import { assembleProject } from "../src/project/assemble.js";
import { PlanSchema } from "../src/schemas/plan.js";
import { draftToPlan, planProblems, resolveMark, type PlanDraft } from "../src/stages/plan.js";
import { staticSceneProblems } from "../src/stages/compose.js";
import { loadStyle } from "../src/styles.js";

function makeImage(file: string, args: string[]) {
  const r = spawnSync(ffmpegPath(), ["-v", "error", "-y", ...args, "-frames:v", "1", file]);
  if (r.status !== 0) throw new Error(String(r.stderr));
}

const basePlan = {
  version: 1,
  topic: "t",
  summary: "s",
  style: "flat-infografik",
  mode: "fullscreen",
  format: "landscape",
  width: 1920,
  height: 1080,
  fps: "30",
  duration_frames: 90,
  handles_frames: 0,
  scenes: [
    {
      id: "s1",
      start_frame: 0,
      end_frame: 90,
      anchor_words: [],
      visual: "v",
      on_screen_text: null,
      camera: "hold",
      technique: "motion-2d",
      assets: [] as unknown[],
      transition_out: "cut",
      image_requests: [],
      sfx: [],
    },
  ],
};
const logo = {
  id: "a1",
  src: "assets/a1.png",
  width: 400,
  height: 200,
  has_alpha: true,
  note: "logo",
};

describe("editor images", () => {
  it("reads size and transparency from ffmpeg's stream line", () => {
    expect(parseImageStream("  Stream #0:0: Video: png, rgba(pc), 1536x1024, 25 tbr")).toEqual({
      width: 1536,
      height: 1024,
      hasAlpha: true,
    });
    expect(
      parseImageStream("  Stream #0:0: Video: mjpeg (Baseline), yuvj420p(pc, bt470bg), 1280x720"),
    ).toMatchObject({ width: 1280, height: 720, hasAlpha: false });
    expect(parseImageStream("Stream #0:0: Video: webp, yuva420p(pc), 640x480").hasAlpha).toBe(true);
    expect(parseImageStream("Stream #0:0: Video: png, rgb24(pc), 64x64").hasAlpha).toBe(false);
    expect(() => parseImageStream("no streams here")).toThrow(/not an image/);
  });

  it("copies, measures and previews the images, and writes assets.json", () => {
    const src = mkdtempSync(join(tmpdir(), "mi-img-"));
    const out = mkdtempSync(join(tmpdir(), "mi-job-"));
    makeImage(join(src, "Logo.PNG"), [
      "-f",
      "lavfi",
      "-i",
      "color=c=red@0.5:s=400x200,format=rgba",
    ]);
    makeImage(join(src, "shot.jpeg"), ["-f", "lavfi", "-i", "color=c=blue:s=1600x1000"]);
    const assets = prepareAssets(
      [{ path: join(src, "Logo.PNG"), note: "  product logo " }, { path: join(src, "shot.jpeg") }],
      out,
    );
    expect(assets.map(({ preview: _p, ...a }) => a)).toEqual([
      {
        id: "a1",
        src: "assets/a1.png",
        width: 400,
        height: 200,
        has_alpha: true,
        note: "product logo",
      },
      { id: "a2", src: "assets/a2.jpg", width: 1600, height: 1000, has_alpha: false, note: null },
    ]);
    expect(assets[0]?.preview.mediaType).toBe("image/png");
    expect(assets[1]?.preview.mediaType).toBe("image/jpeg");
    expect(existsSync(join(out, "assets", "a2.jpg"))).toBe(true);
    expect(readAssets(out)).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(out, "assets.json"), "utf8"))[0]).not.toHaveProperty(
      "preview",
    );
  });

  it("refuses files it cannot use", () => {
    const dir = mkdtempSync(join(tmpdir(), "mi-bad-"));
    writeFileSync(join(dir, "logo.svg"), "<svg/>");
    expect(() => prepareAssets([{ path: join(dir, "logo.svg") }], dir)).toThrow(/not supported/);
    expect(() => prepareAssets([{ path: join(dir, "missing.png") }], dir)).toThrow(/not found/);
  });

  it("checks that scenes use only the editor's images, and reads bare ids as the main subject", () => {
    const ok = PlanSchema.parse({
      ...basePlan,
      assets: [logo],
      scenes: [{ ...basePlan.scenes[0], assets: ["a1"] }],
    });
    expect(ok.scenes[0]?.assets).toEqual([{ id: "a1", role: "hero", marks: [] }]);
    expect(PlanSchema.parse(basePlan).assets).toEqual([]);
    const bad = PlanSchema.safeParse({
      ...basePlan,
      scenes: [{ ...basePlan.scenes[0], assets: [{ id: "a3", role: "logo" }] }],
    });
    expect(bad.success).toBe(false);

    const draft = {
      topic: "t",
      summary: "s",
      scenes: [
        {
          id: "s1",
          start_s: 0,
          end_s: 3,
          anchor_words: [],
          visual: "v",
          on_screen_text: null,
          camera: "hold",
          technique: "motion-2d",
          transition_out: "cut",
          assets: [{ id: "a9", role: "hero" }],
          sfx: [],
        },
      ],
    } as PlanDraft;
    expect(
      planProblems(draft, loadStyle("flat-infografik"), [
        { id: "a1", width: 100, height: 100, lines: [] },
      ]).join(" "),
    ).toMatch(/"a9" is not one of the editor's images/);
  });

  it("rejects a scene that never loads its planned image", () => {
    const html = `<template><div id="root" data-composition-id="s1"></div><script>window.__timelines["s1"] = tl;</script></template>`;
    expect(staticSceneProblems(html, "s1", ["assets/a1.png"]).join(" ")).toMatch(/never loads it/);
    const withImg = html.replace("</div>", '<img id="s1-a1" src="assets/a1.png"></div>');
    expect(staticSceneProblems(withImg, "s1", ["assets/a1.png"])).toEqual([]);
  });

  it("copies the images into the assembled project", () => {
    const job = mkdtempSync(join(tmpdir(), "mi-asm-"));
    makeImage(join(job, "in.png"), ["-f", "lavfi", "-i", "color=c=red:s=64x64"]);
    prepareAssets([{ path: join(job, "in.png") }], job);
    const plan = PlanSchema.parse({
      ...basePlan,
      assets: [{ ...logo, width: 64, height: 64, has_alpha: false, note: null }],
    });
    assembleProject({
      plan,
      scenes: { s1: "<template></template>" },
      projectDir: join(job, "project"),
      assetsDir: join(job, "assets"),
    });
    expect(existsSync(join(job, "project", "assets", "a1.png"))).toBe(true);
    expect(() =>
      assembleProject({
        plan,
        scenes: { s1: "<template></template>" },
        projectDir: join(job, "p2"),
      }),
    ).toThrow(/folder is missing/);
  });

  it("turns marks into exact pixel boxes and reports the ones it cannot place", () => {
    const shot = {
      id: "a1",
      width: 2880,
      height: 1800,
      lines: [
        {
          id: "l4",
          text: "Kare hızı 29,97 fps",
          confidence: 95,
          box: [648, 415, 2105, 28] as [number, number, number, number],
          words: [
            { text: "Kare", box: [648, 415, 60, 23] as [number, number, number, number] },
            { text: "hızı", box: [716, 415, 47, 23] as [number, number, number, number] },
          ],
        },
      ],
    };
    expect(
      resolveMark({ kind: "underline", line: "l4", text: "Kare hızı", at_s: 1 }, shot),
    ).toEqual({ box: [648, 415, 115, 23], text: "Kare hızı" });
    expect(resolveMark({ kind: "box", line: "l4", at_s: 1 }, shot)).toMatchObject({
      box: [648, 415, 2105, 28],
      text: "Kare hızı 29,97 fps",
    });
    expect(resolveMark({ kind: "circle", box: [2600, 1650, 200, 60], at_s: 1 }, shot)).toEqual({
      box: [2600, 1650, 200, 60],
      text: null,
    });
    expect(
      resolveMark({ kind: "underline", line: "l4", text: "fps oranı", at_s: 1 }, shot),
    ).toMatch(/not in line l4/);
    expect(resolveMark({ kind: "circle", box: [2800, 1700, 200, 200], at_s: 1 }, shot)).toMatch(
      /outside a1/,
    );
    expect(resolveMark({ kind: "underline", line: "l9", at_s: 1 }, shot)).toMatch(/was not read/);

    const draft = {
      topic: "t",
      summary: "s",
      scenes: [
        {
          id: "s1",
          start_s: 0,
          end_s: 3,
          anchor_words: [],
          visual: "v",
          on_screen_text: null,
          camera: "hold",
          technique: "ui-mockup",
          transition_out: "cut",
          assets: [
            {
              id: "a1",
              role: "screenshot",
              marks: [{ kind: "underline", line: "l4", text: "hızı", at_s: 1.5 }],
            },
          ],
          sfx: [],
        },
      ],
    } as PlanDraft;
    const plan = draftToPlan(
      draft,
      {
        style: "cam-arayuz",
        mode: "fullscreen",
        format: "landscape",
        width: 1920,
        height: 1080,
        fps: { num: 30, den: 1 },
        handlesFrames: 0,
        assets: [
          {
            ...shot,
            src: "assets/a1.png",
            has_alpha: false,
            note: null,
            preview: { mediaType: "image/png", base64: "" },
          },
        ],
      },
      3,
    );
    expect(plan.scenes[0]?.assets[0]?.marks).toEqual([
      { kind: "underline", box: [716, 415, 47, 23], frame: 45, text: "hızı" },
    ]);
    expect(plan.assets[0]).not.toHaveProperty("lines");
  });
});
