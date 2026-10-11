import { describe, expect, it } from "vitest";
import { PlanSchema, type Plan } from "../src/index.js";

function scene(id: string, start: number, end: number): Plan["scenes"][number] {
  return {
    id,
    start_frame: start,
    end_frame: end,
    anchor_words: ["adım"],
    visual: "clay tokens drop in a row",
    on_screen_text: null,
    camera: "slow push in",
    technique: "three-3d",
    assets: [],
    transition_out: "cut",
    image_requests: [],
    sfx: [{ frame: start + 10, type: "thock", gain_db: -12 }],
  };
}

function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    version: 1,
    topic: "how the plugin works",
    summary: "three steps from speech to animation",
    style: "kil-lacivert",
    mode: "fullscreen",
    format: "landscape",
    width: 1920,
    height: 1080,
    fps: "30000/1001",
    duration_frames: 300,
    handles_frames: 20,
    scenes: [scene("s1", 0, 150), scene("s2", 150, 300)],
    ...overrides,
  };
}

describe("PlanSchema", () => {
  it("accepts a valid plan", () => {
    expect(PlanSchema.safeParse(plan()).success).toBe(true);
  });

  it("rejects overlapping scenes", () => {
    const r = PlanSchema.safeParse(plan({ scenes: [scene("s1", 0, 160), scene("s2", 150, 300)] }));
    expect(r.success).toBe(false);
    expect(r.error?.issues.some((i) => i.message.includes("overlaps"))).toBe(true);
  });

  it("requires scenes to cover the insert from frame 0 to the end", () => {
    expect(PlanSchema.safeParse(plan({ scenes: [scene("s1", 10, 300)] })).success).toBe(false);
    expect(PlanSchema.safeParse(plan({ scenes: [scene("s1", 0, 290)] })).success).toBe(false);
  });

  it("rejects unknown techniques, bad fps and duplicate ids", () => {
    const bad = scene("s1", 0, 300) as Record<string, unknown>;
    bad.technique = "hologram";
    expect(PlanSchema.safeParse(plan({ scenes: [bad as Plan["scenes"][number]] })).success).toBe(
      false,
    );
    expect(PlanSchema.safeParse(plan({ fps: "29.97" })).success).toBe(false);
    expect(
      PlanSchema.safeParse(plan({ scenes: [scene("s1", 0, 150), scene("s1", 150, 300)] })).success,
    ).toBe(false);
  });

  it("rejects sound cues after the end and positive gain", () => {
    const late = scene("s1", 0, 300);
    late.sfx = [{ frame: 300, type: "pop", gain_db: -10 }];
    expect(PlanSchema.safeParse(plan({ scenes: [late] })).success).toBe(false);
    const loud = scene("s1", 0, 300);
    loud.sfx = [{ frame: 5, type: "pop", gain_db: 3 }];
    expect(PlanSchema.safeParse(plan({ scenes: [loud] })).success).toBe(false);
  });
});
