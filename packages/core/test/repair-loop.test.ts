import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckFinding, CheckReport } from "../src/hyperframes.js";
import type { Plan } from "../src/schemas/plan.js";
import type { TextProvider } from "../src/providers/types.js";

// HyperFrames, the pixel checks and the render are stood in for: these tests are about the loop around them
const hf = vi.hoisted(() => ({
  checks: [] as (Partial<CheckReport> & { environmentError: string | null })[],
  haze: [] as CheckFinding[][],
  checkCalls: 0,
}));
vi.mock("../src/hyperframes.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  checkProject: vi.fn(async () => {
    hf.checkCalls++;
    const next = hf.checks.length > 1 ? hf.checks.shift() : hf.checks[0];
    return { ok: false, errors: [], warnings: [], raw: {}, ms: 1, ...next };
  }),
}));
vi.mock("../src/haze.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  overlayHazeFindings: vi.fn(async () => hf.haze.shift() ?? []),
}));
vi.mock("../src/empty.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  emptySceneFindings: vi.fn(async () => []),
}));
vi.mock("../src/failure-picture.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  failurePicture: vi.fn(async () => null),
}));
vi.mock("../src/stages/render.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  renderPlan: vi.fn(async () => ({
    projectDir: "",
    stills: [],
    output: null,
    preview: null,
    sfx: null,
    timingsMs: {},
    warnings: [],
    cutScenes: [],
  })),
}));

const { recomposeScene, renderApproved } = await import("../src/stages/review.js");
const { renderPlan } = await import("../src/stages/render.js");
const { runPipeline } = await import("../src/stages/run.js");

const scene = (word: string) =>
  `\`\`\`html\n<template id="s1-template"><div data-composition-id="s1" data-width="1920" data-height="1080"><div id="s1-title">${word}</div><script>const tl = gsap.timeline({ paused: true }); window.__timelines["s1"] = tl;</script></div></template>\n\`\`\``;

const plan: Plan = {
  version: 1,
  topic: "t",
  summary: "s",
  style: "flat-infografik",
  mode: "fullscreen",
  speaker: null,
  format: "landscape",
  width: 1920,
  height: 1080,
  fps: "25",
  duration_frames: 125,
  handles_frames: 20,
  assets: [],
  scenes: [
    {
      id: "s1",
      start_frame: 0,
      end_frame: 125,
      anchor_words: [],
      visual: "a title",
      on_screen_text: "Title",
      camera: "hold",
      technique: "kinetic-type",
      assets: [],
      transition_out: "cut",
      mode: "fullscreen",
      image_requests: [],
      sfx: [],
    },
  ],
};

function fakeProvider(replies: string[]): TextProvider & { calls: number } {
  const p = {
    name: "fake",
    model: "fake-1",
    capabilities: { vision: true, structuredOutput: false, contextWindow: 200_000 },
    calls: 0,
    async complete() {
      p.calls++;
      return {
        text: replies.shift() ?? scene("again"),
        model: "fake-1",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
  return p;
}

const sceneError: CheckFinding = {
  code: "runtime_error",
  severity: "error",
  section: "runtime",
  message: "s1 throws",
  sourceFile: "compositions/s1.html",
};

let dir: string;
const original = "<template><!-- the approved scene --></template>";
const compositionFile = () => join(dir, "project", "compositions", "s1.html");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kilnframe-repair-"));
  mkdirSync(join(dir, "project", "compositions"), { recursive: true });
  writeFileSync(join(dir, "plan.json"), JSON.stringify(plan));
  writeFileSync(
    join(dir, "transcript.json"),
    JSON.stringify({ version: 1, language: "en", model: "t", duration_s: 5, text: "", words: [] }),
  );
  writeFileSync(compositionFile(), original);
  hf.checks = [];
  hf.haze = [];
  hf.checkCalls = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const defaults = {} as Parameters<typeof recomposeScene>[0]["defaults"];

describe("recomposeScene", () => {
  it("puts the approved scene back when the new one never passes, and still records its cost", async () => {
    hf.checks = [{ errors: [sceneError], environmentError: null }];
    const provider = fakeProvider([scene("new")]);
    await expect(
      recomposeScene({
        outDir: dir,
        sceneId: "s1",
        note: "",
        provider,
        defaults,
        maxRepairRounds: 1,
      }),
    ).rejects.toThrow(/still fails validation/);
    expect(readFileSync(compositionFile(), "utf8")).toBe(original);
    expect(readdirSync(dir).filter((f) => f.startsWith("usage-s1-"))).toHaveLength(1);
  });

  it("does not send a scene to repair when the check's browser cannot run", async () => {
    hf.checks = [
      {
        errors: [{ ...sceneError, code: "check_runtime_failure", sourceFile: "index.html" }],
        environmentError: "Failed to launch the browser process",
      },
    ];
    const provider = fakeProvider([scene("new")]);
    await expect(
      recomposeScene({ outDir: dir, sceneId: "s1", note: "", provider, defaults }),
    ).rejects.toThrow(/could not run on this computer[\s\S]*Failed to launch/);
    expect(provider.calls).toBe(1); // the compose, no repair
    expect(hf.checkCalls).toBe(2); // tried once more
    expect(readFileSync(compositionFile(), "utf8")).toBe(original);
  });

  it("keeps the approved scenes beside a recompose until it ends, and clears them after", async () => {
    const approved = join(dir, ".approved-scenes", "s1.html");
    const seen: (string | null)[] = [];
    const provider = fakeProvider([scene("new")]);
    const complete = provider.complete.bind(provider);
    provider.complete = async (...args: Parameters<typeof complete>) => {
      // a kill now would leave this copy for the next read of the job folder
      seen.push(existsSync(approved) ? readFileSync(approved, "utf8") : null);
      return complete(...args);
    };
    hf.checks = [{ errors: [sceneError], environmentError: null }];
    await expect(
      recomposeScene({ outDir: dir, sceneId: "s1", note: "", provider, defaults }),
    ).rejects.toThrow(/still fails validation/);
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.every((html) => html === original)).toBe(true);
    expect(existsSync(approved)).toBe(false);
  });

  it("puts the approved scenes back before rendering when a recompose never finished", async () => {
    const approved = join(dir, ".approved-scenes");
    mkdirSync(approved, { recursive: true });
    writeFileSync(join(approved, "s1.html"), original);
    writeFileSync(compositionFile(), "<template><!-- an unchecked repair --></template>");
    vi.mocked(renderPlan).mockClear();
    await renderApproved({ outDir: dir });
    const scenes = vi.mocked(renderPlan).mock.calls[0]![0].scenes;
    expect(scenes.s1).toBe(original);
    expect(readFileSync(compositionFile(), "utf8")).toBe(original);
  });

  it("repairs the scene that alone reproduces a runtime failure the page threw", async () => {
    const pageThrew: CheckFinding = {
      code: "check_runtime_failure",
      severity: "error",
      section: "runtime",
      message: "Navigation timeout of 30000 ms exceeded",
      sourceFile: "index.html",
    };
    hf.checks = [
      { errors: [pageThrew], environmentError: null }, // the whole project
      { errors: [pageThrew], environmentError: null }, // s1 alone
      { ok: true, errors: [], environmentError: null },
    ];
    const provider = fakeProvider([scene("new")]);
    const r = await recomposeScene({ outDir: dir, sceneId: "s1", note: "", provider, defaults });
    expect(r.repairRounds).toBe(1);
    expect(provider.calls).toBe(2); // the compose and one repair
  });

  it("gives a pixel finding first seen in the last round one repair of its own", async () => {
    hf.checks = [
      { errors: [sceneError], environmentError: null },
      { ok: true, errors: [], environmentError: null },
    ];
    // round 0: code error; round 1 (the last): the code passes and the pixels show haze; round 2: clean
    hf.haze = [
      [
        {
          code: "overlay_faint_layer",
          severity: "error",
          section: "pixels",
          selector: '[data-composition-id="s1"]',
          message: "haze",
        },
      ],
      [],
    ];
    const provider = fakeProvider([]);
    const r = await recomposeScene({
      outDir: dir,
      sceneId: "s1",
      note: "",
      provider,
      defaults,
      maxRepairRounds: 1,
    });
    expect(r.repairRounds).toBe(2);
  });
});

describe("runPipeline", () => {
  it("writes usage.json when the job fails after paid calls", async () => {
    const provider = fakeProvider(["not a plan", "still not", "nope"]);
    await expect(
      runPipeline({
        audioPath: join(dir, "missing.wav"),
        outDir: dir,
        provider,
        defaults,
        recipes: false,
        transcript: { version: 1, language: "en", model: "t", duration_s: 5, text: "", words: [] },
        job: {
          style: "flat-infografik",
          mode: "fullscreen",
          format: "landscape",
          width: 1920,
          height: 1080,
          fps: { num: 25, den: 1 },
          handlesFrames: 20,
        },
      }),
    ).rejects.toThrow(/valid plan/);
    const usage = JSON.parse(readFileSync(join(dir, "usage.json"), "utf8")) as { calls: unknown[] };
    expect(usage.calls).toHaveLength(3);
  });
});
