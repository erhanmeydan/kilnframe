import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Plan } from "../src/schemas/plan.js";

// the snapshot fails as Chrome would mid-run; everything before it is real
vi.mock("../src/hyperframes.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  snapshotProject: vi.fn(async () => {
    throw new Error("hyperframes snapshot stopped responding");
  }),
}));

const { renderPlan } = await import("../src/stages/render.js");

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

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kf-stills-"));
  mkdirSync(join(dir, "stills"), { recursive: true });
  writeFileSync(join(dir, "stills", "frame-00-at-1.00s.png"), "the last review's still");
  writeFileSync(join(dir, "stills", "edges.json"), '["s1"]\n');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("review stills", () => {
  it("keeps the last review's stills and edge notes when a new snapshot fails", async () => {
    await expect(
      renderPlan({ plan, scenes: {}, outDir: dir, stillsOnly: true, prechecked: true }),
    ).rejects.toThrow(/stopped responding/);
    expect(readFileSync(join(dir, "stills", "frame-00-at-1.00s.png"), "utf8")).toBe(
      "the last review's still",
    );
    expect(readFileSync(join(dir, "stills", "edges.json"), "utf8")).toBe('["s1"]\n');
    expect(existsSync(join(dir, "stills.next"))).toBe(false);
  });
});
