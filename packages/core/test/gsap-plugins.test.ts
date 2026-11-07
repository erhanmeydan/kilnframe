import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { BUILD_READY_GUARD, GSAP_PLUGINS, rootHtml, vendorDir } from "../src/project/assemble.js";
import { draftToPlan, loadPrompt, parseFps } from "../src/index.js";

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

describe("root page", () => {
  it("makes a scene outside its time fully transparent, not only hidden", () => {
    // a hidden scene's SVG filter (a paper grain) was still drawn into every frame
    const html = rootHtml(plan);
    expect(html).toContain(".kf-scene-hidden { opacity: 0 !important; }");
    expect(html).toContain(
      'classList.toggle("kf-scene-hidden", host.style.visibility === "hidden")',
    );
  });

  it("selects nothing on the inline style attribute, which HyperFrames 0.9's check fails", () => {
    expect(rootHtml(plan)).not.toMatch(/\[style[*^$~|]?=/);
  });
});

describe("buildReady guard", () => {
  /** The guard run in a page of its own, with GSAP loaded first as in the root. */
  function page() {
    // GSAP's ticker is never needed here: the timelines stay paused
    const idle = () => 0;
    const win: Record<string, unknown> = {
      requestAnimationFrame: idle,
      cancelAnimationFrame: idle,
      setTimeout: idle,
      clearTimeout: idle,
    };
    win.window = win;
    runInNewContext(readFileSync(join(vendorDir(), "gsap", "gsap.min.js"), "utf8"), win);
    runInNewContext(BUILD_READY_GUARD, win);
    const run = <T>(code: string) => runInNewContext(code, win) as T;
    return run;
  }
  const settled = (p: Promise<unknown>) =>
    Promise.race([
      p.then(
        (v) => ({ value: v }),
        (e: unknown) => ({ error: String(e) }),
      ),
      new Promise((r) => setTimeout(() => r("never settled"), 200)),
    ]);

  it("settles a build that returns its paused timeline, and with nothing", async () => {
    // teknik-cizim's pattern: buildReady = build(), and build ends with `return tl`
    const run = page();
    run(`
      window.__hf = window.__hf || {};
      window.__hf.buildReady = window.__hf.buildReady || {};
      async function build() {
        const tl = gsap.timeline({ paused: true });
        tl.to({ x: 0 }, { x: 1, duration: 2 });
        return tl;
      }
      window.__hf.buildReady["s1"] = build();
    `);
    expect(await settled(run<Promise<unknown>>(`window.__hf.buildReady["s1"]`))).toEqual({
      value: undefined,
    });
  });

  it("still settles builds with nothing after HyperFrames' teardown gives buildReady a new object", async () => {
    // the runtime's teardown (run again on each init) sets window.__hf.buildReady = {}: the scenes registered after
    // it go into that object, and still settle with nothing
    const run = page();
    run(`
      window.__hf.buildReady = {};
      async function build() {
        const tl = gsap.timeline({ paused: true });
        tl.to({ x: 0 }, { x: 1, duration: 2 });
        return tl;
      }
      window.__hf.buildReady["s1"] = build();
    `);
    expect(await settled(run<Promise<unknown>>(`window.__hf.buildReady["s1"]`))).toEqual({
      value: undefined,
    });
    // a scene set before the new object, in the object given, is kept and settled the same way
    run(`window.__hf.buildReady = { s2: Promise.resolve(gsap.timeline({ paused: true })) };`);
    expect(await settled(run<Promise<unknown>>(`window.__hf.buildReady["s2"]`))).toEqual({
      value: undefined,
    });
  });

  it("still passes on a build that failed", async () => {
    const run = page();
    run(`window.__hf.buildReady["s1"] = Promise.reject(new Error("no font"));`);
    expect(await settled(run<Promise<unknown>>(`window.__hf.buildReady["s1"]`))).toEqual({
      error: "Error: no font",
    });
  });

  it("is asked for in the compose prompt too: a build returns nothing, never its timeline", () => {
    const prompt = loadPrompt("compose");
    expect(prompt).toContain('window.__hf.buildReady["SCENE_ID"] = buildPromise;');
    expect(prompt).toContain("The build returns\n  nothing, never the timeline (no `return tl;`)");
  });

  it("is in the root after GSAP, before any scene", () => {
    const html = rootHtml(plan);
    expect(html.indexOf(BUILD_READY_GUARD)).toBeGreaterThan(html.indexOf("gsap.registerPlugin("));
    expect(html.indexOf(BUILD_READY_GUARD)).toBeLessThan(html.indexOf('<div id="root"'));
  });
});
