import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GSAP_PLUGINS, rootHtml, vendorDir } from "../src/project/assemble.js";
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
