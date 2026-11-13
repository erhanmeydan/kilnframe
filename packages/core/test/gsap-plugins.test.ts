import { existsSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { GSAP_PLUGINS, SPLIT_WORDS, rootHtml, vendorDir } from "../src/project/assemble.js";
import { draftToPlan, parseFps } from "../src/index.js";

const plan = draftToPlan(
  {
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
        technique: "kinetic-type",
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
  3,
);

describe("GSAP plugins", () => {
  it("ships every plugin the scenes may use next to GSAP", () => {
    expect(GSAP_PLUGINS).toEqual([
      "SplitText",
      "DrawSVGPlugin",
      "MorphSVGPlugin",
      "MotionPathPlugin",
      "CustomEase",
    ]);
    for (const p of GSAP_PLUGINS)
      expect(existsSync(join(vendorDir(), "gsap", `${p}.min.js`))).toBe(true);
  });

  it("loads them after GSAP in the root and registers them once", () => {
    const html = rootHtml(plan);
    const core = html.indexOf("vendor/gsap/gsap.min.js");
    for (const p of GSAP_PLUGINS)
      expect(html.indexOf(`vendor/gsap/${p}.min.js`)).toBeGreaterThan(core);
    expect(html).toContain(`gsap.registerPlugin(${GSAP_PLUGINS.join(", ")});`);
  });

  it("loads D3 and the icon set for every scene, from the app's own files", () => {
    const html = rootHtml(plan);
    expect(html).toContain('<script src="vendor/d3/d3.min.js"></script>');
    expect(html).toContain('<script src="vendor/icons/lucide.js"></script>');
    expect(existsSync(join(vendorDir(), "d3", "d3.min.js"))).toBe(true);
    expect(existsSync(join(vendorDir(), "icons", "lucide.js"))).toBe(true);
    for (const f of [
      "postprocessing/UnrealBloomPass.js",
      "postprocessing/BokehPass.js",
      "loaders/SVGLoader.js",
    ])
      expect(existsSync(join(vendorDir(), "three", "addons", f))).toBe(true);
  });
});

describe("SplitText words", () => {
  /** The options SplitText.create receives once SPLIT_WORDS has wrapped it. */
  function splitVars(vars?: Record<string, unknown>): Record<string, unknown> {
    let seen: Record<string, unknown> = {};
    const SplitText = { create: (_t: unknown, v: Record<string, unknown>) => (seen = v) };
    runInNewContext(SPLIT_WORDS, { SplitText });
    SplitText.create("#t", vars as Record<string, unknown>);
    return seen;
  }

  it("puts letters in words that do not break", () => {
    expect(splitVars({ type: "chars" })).toEqual({ type: "chars,words", wordsClass: "kf-word" });
    expect(splitVars({ type: "words,chars", mask: "lines" })).toEqual({
      type: "words,chars",
      mask: "lines",
      wordsClass: "kf-word",
    });
    expect(splitVars()).toEqual({ type: "chars,words,lines", wordsClass: "kf-word" });
  });

  it("keeps the scene's own word class", () => {
    expect(splitVars({ type: "words", wordsClass: "w" }).wordsClass).toBe("w kf-word");
  });

  it("runs after the plugins register, with the rule that keeps words whole", () => {
    const html = rootHtml(plan);
    expect(html.indexOf(SPLIT_WORDS)).toBeGreaterThan(html.indexOf("gsap.registerPlugin("));
    expect(html).toContain(".kf-word { white-space: nowrap; }");
  });
});
