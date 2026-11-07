import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  checkProject,
  hyperframesBin,
  hyperframesEnv,
  inCanvasScene,
  parseCheckJson,
  renderProject,
  setHyperframesDirs,
  snapshotProject,
  snapshotStills,
  stillsTaken,
  waitsForRenderSlot,
} from "../src/hyperframes.js";
import { assembleProject, vendorDir } from "../src/project/assemble.js";
import { PlanSchema } from "../src/schemas/plan.js";

// The real CLI starts Chrome, as the caption render tests do.
const RENDER = Boolean(process.env.KILNFRAME_RENDER_TESTS);

/** `seconds` (one by default) of an orange box sliding over navy at 320x180: one renders in a second or two. */
const fixtureHtml = (seconds = 1) => `<!doctype html>
<html><head><meta charset="UTF-8" /><script src="gsap.js"></script>
<style>html,body{margin:0;background:#000}#root{position:absolute;inset:0;overflow:hidden;background:#123}#box{position:absolute;left:40px;top:40px;width:80px;height:80px;background:#f80}</style></head>
<body><div id="root" data-composition-id="fixture" data-start="0" data-width="320" data-height="180" data-duration="${seconds}">
<div id="box"></div></div>
<script>const tl = gsap.timeline({ paused: true }); tl.to("#box", { x: 160, duration: ${seconds}, ease: "none" }, 0); window.__timelines["fixture"] = tl;</script></body></html>
`;

/** The temporary folders a test made, removed after it. */
const made: string[] = [];
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};

function fixture(seconds = 1): string {
  const dir = temp("kf-hf-cli-");
  writeFileSync(join(dir, "index.html"), fixtureHtml(seconds));
  copyFileSync(join(vendorDir(), "gsap", "gsap.min.js"), join(dir, "gsap.js"));
  return dir;
}

const goldenDir = join(import.meta.dirname, "..", "..", "..", "examples", "golden");

/**
 * A golden scene (examples/golden/<name>) assembled as the pipeline does, root page and all; `own` replaces scenes of
 * its plan by id.
 */
function golden(name: string, own: Record<string, string> = {}): string {
  const from = join(goldenDir, name);
  const plan = PlanSchema.parse(JSON.parse(readFileSync(join(from, "plan.json"), "utf8")));
  const scenes = Object.fromEntries(
    plan.scenes.map((s) => [
      s.id,
      own[s.id] ?? readFileSync(join(from, "scenes", `${s.id}.html`), "utf8"),
    ]),
  );
  const dir = temp(`kf-golden-${name}-`);
  assembleProject({ plan, scenes, projectDir: dir, assetsDir: join(from, "assets") });
  return dir;
}

/** A scene of a bar chart drawn in SVG, under a full-frame gradient backdrop written after it. */
const coveredChart = `<!doctype html>
<html><head><meta charset="UTF-8" /></head><body><template>
<style>#s1-root{position:absolute;inset:0;overflow:hidden;background:#e8dcc8}#s1-chart{position:absolute;left:360px;top:240px}#s1-backdrop{position:absolute;inset:0;background:linear-gradient(135deg,#1b2a3a,#2e4a62)}</style>
<div id="s1-root" data-composition-id="s1" data-width="1920" data-height="1080">
<svg id="s1-chart" width="1200" height="600" viewBox="0 0 1200 600">
<rect class="s1-bar" x="0" y="300" width="200" height="300" fill="#3e6e73" />
<rect class="s1-bar" x="300" y="200" width="200" height="400" fill="#3e6e73" />
<rect class="s1-bar" x="600" y="100" width="200" height="500" fill="#d9826b" />
</svg>
<div id="s1-backdrop"></div>
</div>
<script type="module">
const ID = "s1";
window.__hf = window.__hf || {};
window.__hf.buildReady = window.__hf.buildReady || {};
window.__hf.buildReady[ID] = (async () => {
  const tl = gsap.timeline({ paused: true });
  tl.fromTo(".s1-bar", { opacity: 0 }, { opacity: 1, duration: 1, stagger: 0.2 }, 0.2);
  window.__timelines[ID] = tl;
  return true;
})();
</script>
</template></body></html>
`;

/** The brand at bytes 8-11 of an ISO media file: "qt  " for a QuickTime mov, "isom" and the like for an mp4. */
function brand(file: string): string {
  return readFileSync(file).subarray(4, 12).toString("latin1");
}

afterEach(() => {
  setHyperframesDirs({});
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("snapshotStills", () => {
  const files = (names: string[]) => {
    const dir = temp("kf-hf-stills-");
    for (const n of names) writeFileSync(join(dir, n), "");
    return { dir, read: () => snapshotStills(dir).map((f) => f.slice(dir.length + 1)) };
  };

  it("orders the default names by number: frame-100 comes after frame-99", () => {
    const { read } = files([
      "frame-100-at-50s.png",
      "frame-99-at-49.5s.png",
      "frame-02-at-1s.png",
      "contact-sheet.jpg",
    ]);
    expect(read()).toEqual(["frame-02-at-1s.png", "frame-99-at-49.5s.png", "frame-100-at-50s.png"]);
  });

  it("orders the names snapshot --keep writes by their time", () => {
    const { read } = files(["at-12.25s.png", "at-1.5s.png", "at-0s.png", "notes.txt"]);
    expect(read()).toEqual(["at-0s.png", "at-1.5s.png", "at-12.25s.png"]);
  });

  it("gives the numbered stills only from a folder holding both kinds: a number and a time have no one order", () => {
    const { read } = files([
      "frame-01-at-5s.png",
      "at-0.5s.png",
      "frame-00-at-1s.png",
      "at-12s.png",
    ]);
    expect(read()).toEqual(["frame-00-at-1s.png", "frame-01-at-5s.png"]);
  });
});

describe("stillsTaken", () => {
  const folder = (names: string[]) => {
    const dir = temp("kf-hf-taken-");
    for (const n of names) writeFileSync(join(dir, n), "");
    return dir;
  };

  it("gives the stills when there is one for every time asked", () => {
    const dir = folder(["frame-00-at-1s.png", "frame-01-at-2s.png", "contact-sheet.jpg"]);
    expect(stillsTaken(dir, 2).map((f) => f.slice(dir.length + 1))).toEqual([
      "frame-00-at-1s.png",
      "frame-01-at-2s.png",
    ]);
  });

  it("throws on fewer, naming what the folder holds: stills renamed by a later HyperFrames would pass every check unseen", () => {
    const dir = folder(["shot-1.png", "shot-2.png"]);
    expect(() => stillsTaken(dir, 2)).toThrow(/2 stills.*found 0.*shot-1\.png, shot-2\.png/s);
  });

  it("throws on an empty or missing folder", () => {
    expect(() => stillsTaken(folder([]), 1)).toThrow(/found 0/);
    expect(() => stillsTaken(join(temp("kf-hf-taken-"), "none"), 1)).toThrow(/found 0/);
  });

  it("throws on one missing in the middle, which would put every later scene on the wrong frames", () => {
    const dir = folder(["frame-00-at-1s.png", "frame-02-at-3s.png"]);
    expect(() => stillsTaken(dir, 3)).toThrow(/3 stills.*found 2/s);
  });
});

describe("parseCheckJson", () => {
  const finding = (severity: string, code: string) => ({
    code,
    severity,
    message: code,
    selector: "[data-composition-id]",
  });

  it("reads the sections 0.9 added (craft, audio) beside the old ones", () => {
    const report = parseCheckJson(
      JSON.stringify({
        ok: false,
        browserSkipped: false,
        lint: { ok: true, errorCount: 0, findings: [finding("warning", "lint_w")] },
        runtime: { ok: true, errorCount: 0, findings: [] },
        craft: { ok: false, errorCount: 1, findings: [finding("error", "craft_e")] },
        audio: { ok: true, errorCount: 0, findings: [finding("info", "audio_none")] },
        hdr: { autoPromotion: null, inspection: "available" },
        snapshots: { enabled: false, files: [], times: [], findingFiles: [] },
        _meta: { version: "0.9.19" },
      }),
    );
    expect(report.ok).toBe(false);
    expect(report.errors.map((e) => [e.section, e.code])).toEqual([["craft", "craft_e"]]);
    expect(report.warnings.map((e) => [e.section, e.code])).toEqual([["lint", "lint_w"]]);
  });
});

describe("parseCheckJson, a check that failed without a finding", () => {
  it("is an error, so the app never takes it for a pass and its later checks still run", () => {
    // a budget-truncated or timed-out pass: ok false, nothing listed
    const report = parseCheckJson(
      JSON.stringify({
        ok: false,
        lint: { ok: true, errorCount: 0, findings: [] },
        layout: { ok: false, errorCount: 0, findings: [] },
      }),
    );
    expect(report.ok).toBe(false);
    expect(report.errors).toEqual([
      {
        code: "check_unexplained",
        severity: "error",
        section: "layout",
        message: "The check failed without saying why.",
      },
    ]);
  });

  it("is one error for the whole check when no section says it failed", () => {
    const report = parseCheckJson(
      JSON.stringify({ ok: false, lint: { ok: true, errorCount: 0, findings: [] } }),
    );
    expect(report.errors).toEqual([
      {
        code: "check_unexplained",
        severity: "error",
        message: "The check failed without saying why.",
      },
    ]);
  });

  it("adds nothing beside errors that are listed", () => {
    const report = parseCheckJson(
      JSON.stringify({
        ok: false,
        lint: {
          ok: false,
          errorCount: 1,
          findings: [{ severity: "error", message: "bad", code: "x" }],
        },
      }),
    );
    expect(report.errors.map((e) => e.message)).toEqual(["bad"]);
  });
});

describe("parseCheckJson, a finding the app counts as a warning in a scene with a canvas", () => {
  const coveredBg = {
    code: "canvas_covered",
    severity: "error",
    message: "An opaque element covers the canvas above every other visible clip.",
    selector: "#s1-bg",
    sourceFile: "compositions/s1.html",
  };
  const onCanvas = () => true;

  it("reads layout's canvas_covered as a warning in a scene with a canvas, and the check passes when it was the only error", () => {
    // kil-lacivert: the flat background div sits under the WebGL canvas, yet 0.9.13 calls it covering
    const report = parseCheckJson(
      JSON.stringify({
        ok: false,
        layout: { ok: false, errorCount: 1, findings: [coveredBg] },
        lint: { ok: true, errorCount: 0, findings: [] },
      }),
      onCanvas,
    );
    expect(report.errors).toEqual([]);
    expect(report.warnings.map((w) => [w.section, w.code, w.severity])).toEqual([
      ["layout", "canvas_covered", "warning"],
    ]);
    expect(report.ok).toBe(true);
  });

  it("keeps it an error in a scene without a canvas: an opaque cover over a chart hides it", () => {
    const report = parseCheckJson(
      JSON.stringify({ ok: false, layout: { ok: false, errorCount: 1, findings: [coveredBg] } }),
      () => false,
    );
    expect(report.errors.map((e) => [e.section, e.code])).toEqual([["layout", "canvas_covered"]]);
    expect(report.ok).toBe(false);
  });

  it("keeps it an error when no project is given to look in", () => {
    const report = parseCheckJson(
      JSON.stringify({ ok: false, layout: { ok: false, errorCount: 1, findings: [coveredBg] } }),
    );
    expect(report.errors.map((e) => e.code)).toEqual(["canvas_covered"]);
  });

  it("still fails on any other error beside it", () => {
    const report = parseCheckJson(
      JSON.stringify({
        ok: false,
        layout: {
          ok: false,
          errorCount: 2,
          findings: [coveredBg, { ...coveredBg, code: "content_overflow" }],
        },
      }),
      onCanvas,
    );
    expect(report.errors.map((e) => e.code)).toEqual(["content_overflow"]);
    expect(report.ok).toBe(false);
  });

  it("does not let a demoted finding pass a section that failed for another reason it does not list", () => {
    // layout failed with one error, the demoted one; motion failed with none listed (a pass cut short)
    const report = parseCheckJson(
      JSON.stringify({
        ok: false,
        layout: { ok: false, errorCount: 1, findings: [coveredBg] },
        motion: { ok: false, errorCount: 0, findings: [] },
      }),
      onCanvas,
    );
    expect(report.ok).toBe(false);
    expect(report.errors.map((e) => [e.section, e.message])).toEqual([
      ["motion", "The check failed without saying why."],
    ]);
  });

  it("does not let a demoted finding pass a section whose error count is larger than its listed errors", () => {
    const report = parseCheckJson(
      JSON.stringify({ ok: false, layout: { ok: false, errorCount: 2, findings: [coveredBg] } }),
      onCanvas,
    );
    expect(report.ok).toBe(false);
    expect(report.errors.map((e) => e.section)).toEqual(["layout"]);
  });

  it("keeps canvas_covered an error from any other section", () => {
    const report = parseCheckJson(
      JSON.stringify({ ok: false, craft: { ok: false, errorCount: 1, findings: [coveredBg] } }),
      onCanvas,
    );
    expect(report.errors.map((e) => e.code)).toEqual(["canvas_covered"]);
    expect(report.ok).toBe(false);
  });
});

describe("inCanvasScene", () => {
  const project = (scenes: Record<string, string>) => {
    const dir = temp("kf-hf-scenes-");
    mkdirSync(join(dir, "compositions"));
    writeFileSync(join(dir, "index.html"), "<div data-composition-id='root'></div>");
    for (const [id, html] of Object.entries(scenes))
      writeFileSync(join(dir, "compositions", `${id}.html`), html);
    return dir;
  };
  const gl = '<canvas id="s1-gl" width="1920" height="1080"></canvas><div id="s1-bg"></div>';
  const chart = '<svg id="s2-chart"></svg><div id="s2-cover"></div>';

  it("finds the scene by the finding's source file", () => {
    const at = inCanvasScene(project({ s1: gl, s2: chart }));
    expect(at({ severity: "error", message: "", sourceFile: "compositions/s1.html" })).toBe(true);
    expect(at({ severity: "error", message: "", sourceFile: "compositions/s2.html" })).toBe(false);
  });

  it("finds the scene by the selector's id when there is no source file", () => {
    const at = inCanvasScene(project({ s1: gl, s2: chart, s10: chart }));
    expect(at({ severity: "error", message: "", selector: "#s1-bg" })).toBe(true);
    expect(at({ severity: "error", message: "", selector: "#s2-cover" })).toBe(false);
    // s10's selector is not s1's
    expect(at({ severity: "error", message: "", selector: "#s10-cover" })).toBe(false);
  });

  it("counts a canvas a scene's script makes", () => {
    const at = inCanvasScene(
      project({
        s1: '<div id="s1-bg"></div><script>document.body.appendChild(document.createElement("canvas"))</script>',
      }),
    );
    expect(at({ severity: "error", message: "", selector: "#s1-bg" })).toBe(true);
  });

  it("says no for the root page, a scene it cannot find and a file outside the project", () => {
    const dir = project({ s1: gl });
    const at = inCanvasScene(dir);
    expect(at({ severity: "error", message: "", sourceFile: "index.html" })).toBe(false);
    expect(at({ severity: "error", message: "", selector: "#s9-bg" })).toBe(false);
    expect(at({ severity: "error", message: "", selector: "[data-composition-id]" })).toBe(false);
    writeFileSync(join(dir, "..", "outside.html"), gl);
    made.push(join(dir, "..", "outside.html"));
    expect(at({ severity: "error", message: "", sourceFile: "../outside.html" })).toBe(false);
  });
});

describe("waitsForRenderSlot", () => {
  it("knows the line HyperFrames 0.9 prints while another render holds the slot", () => {
    expect(
      waitsForRenderSlot(
        "  Waiting for another render to finish (pid 4242, project /p, running 3s). Renders run one at a time per user account; pass --no-wait to stop instead.",
      ),
    ).toBe(true);
    expect(waitsForRenderSlot('@hf-progress {"stage":"capture"}')).toBe(false);
    expect(waitsForRenderSlot("  Lock: /cache/locks/render.lock")).toBe(false);
  });
});

describe("hyperframesEnv", () => {
  it("passes the app's cache and settings folders to HyperFrames", () => {
    setHyperframesDirs({ cacheDir: "/app/hf-cache", configDir: "/app/hf-config" });
    const env = hyperframesEnv({ PATH: "/bin", HYPERFRAMES_CACHE_DIR: "/elsewhere" });
    expect(env).toMatchObject({
      PATH: "/bin",
      HYPERFRAMES_CACHE_DIR: "/app/hf-cache",
      HYPERFRAMES_CONFIG_DIR: "/app/hf-config",
      HYPERFRAMES_NO_TELEMETRY: "1",
    });
  });

  it("turns off the warm check, whose process outlives the run (CI is its only switch in 0.9)", () => {
    expect(hyperframesEnv({ PATH: "/bin" }).CI).toBe("1");
  });

  it("leaves HyperFrames' own folders alone when the app gives none", () => {
    const env = hyperframesEnv({ PATH: "/bin" });
    expect(env.HYPERFRAMES_CACHE_DIR).toBeUndefined();
    expect(env.HYPERFRAMES_CONFIG_DIR).toBeUndefined();
  });
});

/**
 * HyperFrames' warm-check processes (0.9: started detached when a check ends) whose working folder is dir, by pid.
 * Read with pgrep and lsof, so macOS and Linux only.
 */
function warmChecksIn(dir: string): number[] {
  const pids = spawnSync("pgrep", ["-f", "warmCheck.js"], { encoding: "utf8" })
    .stdout.split("\n")
    .map(Number)
    .filter((n) => n > 0);
  const want = realpathSync(dir);
  return pids.filter((pid) => {
    const cwd = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      encoding: "utf8",
    })
      .stdout.split("\n")
      .find((l) => l.startsWith("n"));
    return cwd?.slice(1) === want;
  });
}

/** The browser HyperFrames launches, under the environment a run gets now. */
const browserPath = () =>
  spawnSync(process.execPath, [hyperframesBin(), "browser", "path"], {
    env: hyperframesEnv(),
    encoding: "utf8",
  }).stdout.trim();

describe.skipIf(!RENDER)("the pinned HyperFrames CLI", () => {
  // HyperFrames' own pick of Chrome, from its own cache folder; every run below keeps its caches in a folder of
  // its own (none adds a copy of the fixture to ~/.cache/hyperframes/history), and is told that Chrome by path,
  // as an app does: with another cache folder, HyperFrames would look for its Chrome there
  let chrome = "";
  const shellBefore = process.env.PRODUCER_HEADLESS_SHELL_PATH;
  beforeAll(() => {
    chrome = browserPath();
  });
  beforeEach(() => {
    process.env.PRODUCER_HEADLESS_SHELL_PATH = chrome;
    setHyperframesDirs({ cacheDir: temp("kf-hf-cache-"), configDir: temp("kf-hf-config-") });
  });
  afterEach(() => {
    if (shellBefore === undefined) delete process.env.PRODUCER_HEADLESS_SHELL_PATH;
    else process.env.PRODUCER_HEADLESS_SHELL_PATH = shellBefore;
  });

  it("snapshot writes frames the readers find", async () => {
    const dir = fixture();
    const out = join(dir, "shots");
    await snapshotProject(dir, [0.25, 0.5, 0.75], out);
    expect(snapshotStills(out).map((f) => f.slice(out.length + 1))).toEqual([
      "frame-00-at-0.25s.png",
      "frame-01-at-0.5s.png",
      "frame-02-at-0.75s.png",
    ]);
  }, 120_000);

  it("check --json parses with the new sections", async () => {
    const report = await checkProject(fixture());
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    // the box enters from nothing at 0 s: craft's first-frame warning, a section 0.8 did not have
    expect(report.warnings.map((w) => [w.section, w.code])).toContainEqual([
      "craft",
      "first_frame_empty",
    ]);
  }, 120_000);

  it("@hf-progress lines still give frame counts", async () => {
    const dir = fixture();
    const frames: [number, number][] = [];
    await renderProject(dir, {
      fps: "30",
      output: join(dir, "renders", "out.mp4"),
      format: "mp4",
      onFrames: (done, total) => frames.push([done, total]),
    });
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.at(-1)).toEqual([30, 30]);
  }, 120_000);

  it("a render that waits for another says so (onWait), and both finish", async () => {
    // the second starts once the first holds HyperFrames' render slot, and the first is long enough to still hold
    // it when the second asks: started together, a slow start of one could find the other done and never wait
    const dir = fixture(5);
    const cacheDir = temp("kf-hf-cache-");
    setHyperframesDirs({ cacheDir, configDir: temp("kf-hf-config-") });
    const waited: string[] = [];
    const render = (name: string) =>
      renderProject(dir, {
        fps: "30",
        output: join(dir, "renders", `${name}.mp4`),
        format: "mp4",
        onFrames: () => {},
        onWait: () => waited.push(name),
      });
    const first = render("a");
    const slot = join(cacheDir, "locks", "render.lock");
    for (let i = 0; i < 200 && !existsSync(slot); i++) await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(slot)).toBe(true);
    await Promise.all([first, render("b")]);
    expect(waited).toEqual(["b"]);
    expect(
      existsSync(join(dir, "renders", "a.mp4")) && existsSync(join(dir, "renders", "b.mp4")),
    ).toBe(true);
  }, 120_000);

  it("render honours -o and --format", async () => {
    const dir = fixture();
    const mov = join(dir, "renders", "master.mov");
    const mp4 = join(dir, "renders", "master.mp4");
    await renderProject(dir, { fps: "30", output: mov, format: "mov" });
    await renderProject(dir, { fps: "30", output: mp4, format: "mp4" });
    expect(brand(mov)).toBe("ftypqt  ");
    expect(brand(mp4)).toMatch(/^ftyp(isom|mp42)/);
  }, 120_000);

  it("passes a project of the core's root page: no rule of its own fails 0.9's lint", async () => {
    // the root's haze rule read the inline style attribute, an error since 0.9.0 in every project
    const report = await checkProject(golden("flat-infografik"));
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
  }, 120_000);

  it("a WebGL background under a canvas is a warning: kil-lacivert passes", async () => {
    const report = await checkProject(golden("kil-lacivert"));
    expect(report.warnings.map((w) => [w.section, w.code])).toContainEqual([
      "layout",
      "canvas_covered",
    ]);
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
  }, 120_000);

  it("a full-frame opaque backdrop over an SVG chart, in a scene without a canvas, stays an error", async () => {
    // the slip the check is there for: the backdrop comes after the content, so the frame shows only it
    const report = await checkProject(golden("flat-infografik", { s1: coveredChart }));
    expect(report.errors.map((e) => [e.section, e.code])).toContainEqual([
      "layout",
      "canvas_covered",
    ]);
    expect(report.ok).toBe(false);
  }, 120_000);

  it("snapshots a scene whose async build returns its timeline", async () => {
    // teknik-cizim's scenes register buildReady = build() and end build with `return tl`: the promise took
    // the paused timeline's then and never settled, and 0.9's snapshot waited 45 s for it, then failed
    const dir = golden("teknik-cizim");
    expect(readFileSync(join(dir, "compositions", "s1.html"), "utf8")).toContain("return tl;");
    const out = join(dir, "shots");
    await snapshotProject(dir, [4], out);
    expect(snapshotStills(out)).toHaveLength(1);
  }, 120_000);

  it.skipIf(process.platform === "win32")(
    "a check leaves no warm-check process behind, holding a Chrome and the project as its folder",
    async () => {
      // a short cache folder: the warm process listens on <cache>/warm/<12 hex>.sock, and a path over macOS's
      // 103 bytes makes it quit at once, which would hide it (the reviewer's home folder did)
      const cache = mkdtempSync("/tmp/kfw-");
      made.push(cache);
      setHyperframesDirs({ cacheDir: cache, configDir: temp("kf-hf-config-") });
      const dir = fixture();
      await checkProject(dir);
      await new Promise((r) => setTimeout(r, 1000));
      const left = warmChecksIn(dir);
      for (const pid of left) process.kill(pid);
      expect(left).toEqual([]);
    },
    120_000,
  );

  it("keeps HyperFrames' caches in the folders the app gives, and renders with the Chrome it is told", async () => {
    const dirs = temp("kf-hf-dirs-");
    setHyperframesDirs({ cacheDir: join(dirs, "cache"), configDir: join(dirs, "config") });
    expect(browserPath()).toBe(chrome);
    await checkProject(fixture());
    expect(existsSync(join(dirs, "cache", "history"))).toBe(true);
    expect(existsSync(join(dirs, "config", "config.json"))).toBe(true);
    // no Chrome fetched into the app's cache folder
    expect(existsSync(join(dirs, "cache", "chrome"))).toBe(false);
  }, 120_000);
});
