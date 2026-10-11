import { describe, expect, it } from "vitest";
import {
  composeRequest,
  draftToPlan,
  loadStyle,
  overlayPlacement,
  parseFps,
  parseFrameArg,
  planInsert,
  planProblems,
  sceneMode,
  type PlanDraft,
  type PlanJob,
  type RangeFrame,
  type TextProvider,
  type TextRequest,
  type Transcript,
} from "../src/index.js";

const frames: RangeFrame[] = [1.5, 5.4, 9.3].map((atS, i) => ({
  atS,
  file: `/tmp/f${i + 1}.png`,
  preview: { mediaType: "image/jpeg", base64: `RlJBTUU${i}` },
}));

const job: PlanJob = {
  style: "beyaz-tahta",
  mode: "auto",
  format: "landscape",
  width: 1920,
  height: 1080,
  fps: parseFps("25"),
  handlesFrames: 20,
  frames,
};

const transcript: Transcript = {
  version: 1,
  language: "tr",
  model: "test",
  duration_s: 10,
  text: "Üç adımda video yapıyoruz",
  words: [
    { text: "Üç", start: 0.5, end: 0.8 },
    { text: "adımda", start: 0.8, end: 1.3 },
    { text: "video", start: 5.2, end: 5.6 },
    { text: "yapıyoruz", start: 5.6, end: 6.3 },
  ],
};

function draft(
  modes: ("fullscreen" | "overlay" | undefined)[],
  side?: PlanDraft["speaker_side"],
): PlanDraft {
  return {
    topic: "steps",
    summary: "three steps",
    ...(side ? { speaker_side: side } : {}),
    scenes: modes.map((mode, i) => ({
      id: `s${i + 1}`,
      start_s: i * 5,
      end_s: i * 5 + 5,
      anchor_words: ["adımda"],
      visual: "a marker draws three boxes",
      on_screen_text: "ÜÇ ADIM",
      camera: "hold",
      technique: "diagram" as const,
      transition_out: "cut",
      ...(mode ? { mode } : {}),
      assets: [],
      sfx: [],
    })),
  };
}

function fakeProvider(replies: string[]): TextProvider & { requests: TextRequest[] } {
  const requests: TextRequest[] = [];
  return {
    name: "fake",
    model: "fake-1",
    capabilities: { vision: true, structuredOutput: false, contextWindow: 200_000 },
    requests,
    async complete(req) {
      requests.push(structuredClone(req));
      const text = replies.shift();
      if (text === undefined) throw new Error("no more scripted replies");
      return { text, model: "fake-1", usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
}

describe("automatic mode in the plan", () => {
  it("keeps each scene's mode and renders with alpha when one scene is an overlay", () => {
    const plan = draftToPlan(draft(["overlay", "fullscreen"], "left"), job, 10);
    expect(plan.scenes.map((s) => s.mode)).toEqual(["overlay", "fullscreen"]);
    expect(plan.mode).toBe("overlay");
    expect(plan.speaker).toEqual({ side: "left" });
  });

  it("stays a plain fullscreen insert when every scene covers the footage", () => {
    const plan = draftToPlan(draft(["fullscreen", "fullscreen"], "center"), job, 10);
    expect(plan.mode).toBe("fullscreen");
  });

  it("follows a fixed mode whatever the model wrote, and has no speaker without frames", () => {
    const fixed = { ...job, mode: "fullscreen" as const, frames: [] };
    const plan = draftToPlan(draft(["overlay", "overlay"]), fixed, 10);
    expect(plan.scenes.map((s) => s.mode)).toEqual(["fullscreen", "fullscreen"]);
    expect(plan.mode).toBe("fullscreen");
    expect(plan.speaker).toBeNull();
  });

  it("asks for a missing scene mode and speaker side, only in automatic mode", () => {
    const style = loadStyle("beyaz-tahta");
    const problems = planProblems(draft(["overlay", undefined]), style, [], job);
    expect(problems.some((p) => p.includes("speaker_side"))).toBe(true);
    expect(problems.some((p) => p.includes("scenes[1].mode"))).toBe(true);
    expect(planProblems(draft([undefined, undefined]), style, [], { mode: "fullscreen" })).toEqual(
      [],
    );
  });

  it("reads plans written before modes were chosen per scene", () => {
    expect(sceneMode({ mode: "overlay" }, {})).toBe("overlay");
    expect(sceneMode({ mode: "overlay" }, { mode: "fullscreen" })).toBe("fullscreen");
  });

  it("shows the model the frames first and tells it what they are", async () => {
    const provider = fakeProvider([JSON.stringify(draft(["overlay", "fullscreen"], "right"))]);
    const plan = await planInsert({
      provider,
      transcript,
      style: loadStyle("beyaz-tahta"),
      job,
    });
    expect(plan.speaker).toEqual({ side: "right" });
    const content = provider.requests[0]?.messages[0]?.content ?? [];
    expect(content.slice(0, 3).every((p) => p.type === "image")).toBe(true);
    const text = content.find((p) => p.type === "text");
    expect(text?.type === "text" && text.text).toContain("frames of the footage");
    expect(text?.type === "text" && text.text).toContain("Output: automatic");
  });
});

describe("automatic mode in the scenes", () => {
  const style = loadStyle("beyaz-tahta");
  const plan = draftToPlan(draft(["overlay", "fullscreen"], "left"), job, 10);
  const ctx = { provider: fakeProvider([]), plan, transcript, style, frames };

  it("places an overlay on the free side and shows the model the footage under it", () => {
    const parts = composeRequest(ctx, plan.scenes[0]!);
    const text = parts.find((p) => p.type === "text");
    expect(text?.type === "text" && text.text).toContain("Mode: overlay");
    expect(text?.type === "text" && text.text).toContain("right half");
    const images = parts.filter((p) => p.type === "image");
    // the frame nearest the scene's middle (2.5 s) comes last
    expect(images.at(-1)).toMatchObject({ base64: "RlJBTUU0" });
  });

  it("makes a fullscreen scene of a mixed insert paint its own ground", () => {
    const parts = composeRequest(ctx, plan.scenes[1]!);
    const text = parts.find((p) => p.type === "text");
    expect(text?.type === "text" && text.text).toContain("opaque background");
    expect(
      parts.filter((p) => p.type === "image").some((p) => p.base64.startsWith("RlJBTUU")),
    ).toBe(false);
  });

  it("says where overlays may go for each speaker position", () => {
    const at = (side: "left" | "center" | "right" | "none", format = "landscape" as const) =>
      overlayPlacement({ ...plan, format, speaker: { side } });
    expect(at("right")).toContain("left half");
    expect(at("center")).toContain("middle 40%");
    expect(at("none")).toContain("whole frame");
    expect(overlayPlacement({ ...plan, format: "portrait", speaker: { side: "left" } })).toContain(
      "above the head",
    );
  });
});

describe("--frame", () => {
  it("reads a file and a time", () => {
    expect(parseFrameArg("/x/f@1.png@2.5")).toEqual({ path: "/x/f@1.png", atS: 2.5 });
    expect(() => parseFrameArg("/x/f.png")).toThrow(/--frame/);
  });
});

describe("preview of an insert with alpha", () => {
  const base = {
    speech: "/s.wav",
    sfx: "/x.wav",
    output: "/p.mp4",
    fps: "25",
    handlesFrames: 20,
  };

  it("lays a ProRes 4444 insert over a frame of the footage as H.264", async () => {
    const { previewArgs } = await import("../src/index.js");
    const args = previewArgs({ ...base, video: "/i.mov", backdrop: "/f2.png" });
    expect(args).toContain("/f2.png");
    expect(args.join(" ")).toContain("overlay=shortest=1");
    expect(args).toContain("libx264");
  });

  it("prefers the range's own picture, held over the handles", async () => {
    const { previewArgs } = await import("../src/index.js");
    const args = previewArgs({
      ...base,
      video: "/i.mov",
      backdrop: "/f2.png",
      footage: "/footage.mp4",
    });
    expect(args).toContain("/footage.mp4");
    expect(args).not.toContain("/f2.png");
    // 20 frames at 25 fps
    expect(args.join(" ")).toContain("tpad=start_duration=0.800:start_mode=clone");
  });

  it("copies an MP4 insert as before", async () => {
    const { previewArgs } = await import("../src/index.js");
    const args = previewArgs({ ...base, video: "/i.mp4" });
    expect(args.join(" ")).toContain("-c:v copy");
  });
});
