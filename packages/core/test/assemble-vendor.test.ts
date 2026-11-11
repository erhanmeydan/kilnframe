import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assembleProject } from "../src/project/assemble.js";
import { draftToPlan, parseFps } from "../src/index.js";

const plan = draftToPlan(
  {
    topic: "t",
    summary: "s",
    scenes: [
      {
        id: "s1",
        start_s: 0,
        end_s: 2,
        anchor_words: [],
        visual: "v",
        on_screen_text: null,
        camera: "hold",
        technique: "motion-2d",
        transition_out: "cut",
        assets: [],
        sfx: [],
      },
    ],
  },
  {
    style: "flat-infografik",
    mode: "fullscreen",
    format: "landscape",
    width: 1920,
    height: 1080,
    fps: parseFps("30"),
    handlesFrames: 0,
  },
  2,
);

afterEach(() => vi.unstubAllEnvs());

describe("the project's vendor folder", () => {
  it("is copied once per job, and again only when the core's own vendor files changed", () => {
    const source = mkdtempSync(join(tmpdir(), "kf-vendor-src-"));
    mkdirSync(join(source, "gsap"));
    writeFileSync(join(source, "gsap", "gsap.min.js"), "one");
    vi.stubEnv("KILNFRAME_VENDOR_DIR", source);
    const projectDir = join(mkdtempSync(join(tmpdir(), "kf-vendor-job-")), "project");
    const scenes = { s1: "<template></template>" };
    const copy = join(projectDir, "vendor", "gsap", "gsap.min.js");

    assembleProject({ plan, scenes, projectDir });
    expect(readFileSync(copy, "utf8")).toBe("one");
    // a repair round: the copy is left as it is
    writeFileSync(copy, "kept");
    assembleProject({ plan, scenes, projectDir });
    expect(readFileSync(copy, "utf8")).toBe("kept");
    // the core's file changed (an update): copied again
    writeFileSync(join(source, "gsap", "gsap.min.js"), "two!");
    utimesSync(join(source, "gsap", "gsap.min.js"), new Date(), new Date(Date.now() + 5_000));
    assembleProject({ plan, scenes, projectDir });
    expect(readFileSync(copy, "utf8")).toBe("two!");
  });
});
