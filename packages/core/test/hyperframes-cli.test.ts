import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkProject,
  hyperframesEnv,
  parseCheckJson,
  renderProject,
  setHyperframesDirs,
  snapshotProject,
  snapshotStills,
} from "../src/hyperframes.js";
import { vendorDir } from "../src/project/assemble.js";

// The real CLI starts Chrome, as the caption render tests do.
const RENDER = Boolean(process.env.KILNFRAME_RENDER_TESTS);

/** One second of an orange box sliding over navy at 320x180: small enough for a render in a second or two. */
const FIXTURE = `<!doctype html>
<html><head><meta charset="UTF-8" /><script src="gsap.js"></script>
<style>html,body{margin:0;background:#000}#root{position:absolute;inset:0;overflow:hidden;background:#123}#box{position:absolute;left:40px;top:40px;width:80px;height:80px;background:#f80}</style></head>
<body><div id="root" data-composition-id="fixture" data-start="0" data-width="320" data-height="180" data-duration="1">
<div id="box"></div></div>
<script>const tl = gsap.timeline({ paused: true }); tl.to("#box", { x: 160, duration: 1, ease: "none" }, 0); window.__timelines["fixture"] = tl;</script></body></html>
`;

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "kf-hf-cli-"));
  writeFileSync(join(dir, "index.html"), FIXTURE);
  copyFileSync(join(vendorDir(), "gsap", "gsap.min.js"), join(dir, "gsap.js"));
  return dir;
}

/** The brand at bytes 8-11 of an ISO media file: "qt  " for a QuickTime mov, "isom" and the like for an mp4. */
function brand(file: string): string {
  return readFileSync(file).subarray(4, 12).toString("latin1");
}

afterEach(() => setHyperframesDirs({}));

describe("snapshotStills", () => {
  const files = (names: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), "kf-hf-stills-"));
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

  it("leaves HyperFrames' own folders alone when the app gives none", () => {
    const env = hyperframesEnv({ PATH: "/bin" });
    expect(env.HYPERFRAMES_CACHE_DIR).toBeUndefined();
    expect(env.HYPERFRAMES_CONFIG_DIR).toBeUndefined();
  });
});

describe.skipIf(!RENDER)("the pinned HyperFrames CLI", () => {
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

  it("render honours -o and --format", async () => {
    const dir = fixture();
    const mov = join(dir, "renders", "master.mov");
    const mp4 = join(dir, "renders", "master.mp4");
    await renderProject(dir, { fps: "30", output: mov, format: "mov" });
    await renderProject(dir, { fps: "30", output: mp4, format: "mp4" });
    expect(brand(mov)).toBe("ftypqt  ");
    expect(brand(mp4)).toMatch(/^ftyp(isom|mp42)/);
  }, 120_000);

  it("keeps HyperFrames' caches in the folders the app gives", async () => {
    const dirs = mkdtempSync(join(tmpdir(), "kf-hf-dirs-"));
    setHyperframesDirs({ cacheDir: join(dirs, "cache"), configDir: join(dirs, "config") });
    await checkProject(fixture());
    expect(existsSync(join(dirs, "cache", "history"))).toBe(true);
    expect(existsSync(join(dirs, "config", "config.json"))).toBe(true);
  }, 120_000);
});
