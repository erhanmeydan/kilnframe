import { describe, expect, it } from "vitest";
import {
  deliverArgs,
  parseCheckJson,
  rootHtml,
  seconds,
  stillTimes,
  targetMbps,
  type Plan,
} from "../src/index.js";

const plan: Plan = {
  version: 1,
  topic: "Test <topic>",
  summary: "s",
  style: "kil-lacivert",
  mode: "fullscreen",
  format: "landscape",
  width: 1920,
  height: 1080,
  fps: "30000/1001",
  duration_frames: 300,
  handles_frames: 20,
  scenes: [0, 1].map((i) => ({
    id: `s${i + 1}`,
    start_frame: i * 150,
    end_frame: (i + 1) * 150,
    anchor_words: [],
    visual: "v",
    on_screen_text: null,
    camera: "c",
    technique: "three-3d" as const,
    assets: [],
    transition_out: "cut",
    image_requests: [],
    sfx: [],
  })),
};

describe("rootHtml", () => {
  it("places scenes back to back with exact NTSC times", () => {
    expect(seconds(150, "30000/1001")).toBe("5.005");
    expect(seconds(0, "25")).toBe("0");
    const html = rootHtml(plan);
    expect(html).toContain(
      'data-composition-src="compositions/s1.html" data-start="0" data-duration="5.005"',
    );
    expect(html).toContain(
      'data-composition-src="compositions/s2.html" data-start="5.005" data-duration="5.005"',
    );
    expect(html).toContain('data-duration="10.01"');
    expect(html).toContain("<title>Test &lt;topic&gt;</title>");
    expect(html).toContain('window.__timelines["main"]');
  });

  it("keeps the background transparent in overlay mode", () => {
    expect(rootHtml({ ...plan, mode: "overlay" })).toContain("background: transparent");
  });
});

describe("stillTimes", () => {
  it("samples each scene late, once its reveals have settled", () => {
    expect(stillTimes(plan).map((t) => t.toFixed(4))).toEqual(["4.0040", "9.0090"]);
  });

  it("stays clear of the end of a short scene but never before its middle", () => {
    const short = { ...plan, scenes: [{ ...plan.scenes[0]!, start_frame: 0, end_frame: 30 }] };
    // 1.001 s long: 80% is 0.8008 s, the end guard 0.801 s, the middle 0.5005 s
    expect(stillTimes(short).map((t) => t.toFixed(4))).toEqual(["0.8008"]);
    const tiny = { ...plan, scenes: [{ ...plan.scenes[0]!, start_frame: 0, end_frame: 12 }] };
    // 0.4004 s long: the end guard (0.2004 s) wins over 80%, the middle is 0.2002 s
    expect(stillTimes(tiny).map((t) => t.toFixed(4))).toEqual(["0.2004"]);
  });

  it("waits for the scene's last spoken word to be revealed", () => {
    // scenes run 0 to 5.005 s and 5.005 to 10.01 s
    const t = (words: number[]) =>
      stillTimes(
        plan,
        words.map((start) => ({ start })),
      ).map((x) => x.toFixed(4));
    // last words at 2.4 s and 7.0 s, plus 0.6 s for their reveal
    expect(t([0.5, 2.4, 6, 7])).toEqual(["3.0000", "7.6000"]);
    // a word near the end is held 0.2 s before it, out of the exit
    expect(t([4.9])[0]).toBe("4.8050");
    // an early last word still waits for the middle
    expect(t([0.3])[0]).toBe("2.5025");
  });
});

describe("parseCheckJson", () => {
  it("collects errors and warnings from every section", () => {
    const json = JSON.stringify({
      ok: false,
      browserSkipped: false,
      lint: {
        ok: false,
        errorCount: 1,
        findings: [{ severity: "error", message: "bad", code: "x" }],
      },
      runtime: { ok: true, errorCount: 0, findings: [{ severity: "warning", message: "meh" }] },
      layout: { ok: true, errorCount: 0, findings: [] },
    });
    const r = parseCheckJson(`noise before\n${json}`);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.message)).toEqual(["bad"]);
    expect(r.warnings.map((e) => e.message)).toEqual(["meh"]);
    expect(r.errors[0]?.section).toBe("lint");
    expect(r.warnings[0]?.section).toBe("runtime");
  });

  it("treats skipped browser checks as an error", () => {
    const r = parseCheckJson(JSON.stringify({ ok: true, browserSkipped: true }));
    expect(r.ok).toBe(false);
  });
});

describe("deliverArgs", () => {
  const base = {
    input: "in.mp4",
    output: "out.mp4",
    fps: "30000/1001",
    width: 1920,
    height: 1080,
    handlesFrames: 20,
  };

  it("encodes fullscreen as capped H.264 with cloned handles", () => {
    const args = deliverArgs({ ...base, mode: "fullscreen" }).join(" ");
    expect(args).toContain("tpad=start=20:stop=20:start_mode=clone:stop_mode=clone");
    expect(args).toContain("-c:v libx264");
    expect(args).toContain("-b:v 20M -maxrate 30M");
    expect(args).toContain("-r 30000/1001");
    expect(args).toContain("-an");
  });

  it("encodes overlay as ProRes 4444 with alpha", () => {
    const args = deliverArgs({ ...base, output: "out.mov", mode: "overlay" }).join(" ");
    expect(args).toContain("-c:v prores_ks -profile:v 4");
    expect(args).toContain("yuva444p10le");
  });

  it("skips padding when there are no handles and scales bitrate with size", () => {
    expect(deliverArgs({ ...base, handlesFrames: 0, mode: "fullscreen" }).join(" ")).not.toContain(
      "tpad",
    );
    expect(targetMbps(3840, 2160)).toBe(80);
    expect(targetMbps(1080, 1080)).toBe(11);
  });
});

describe("parseGpuLine", () => {
  it("reads the GPU mode and renderer from HyperFrames output", async () => {
    const { parseGpuLine } = await import("../src/index.js");
    expect(
      parseGpuLine(
        '[hyperframes] browserGpuMode probe → hardware (WebGL renderer vendor="Google Inc. (Apple)" renderer="ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Max, Unspecified Version)")',
      ),
    ).toEqual({
      mode: "hardware",
      renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Max, Unspecified Version)",
    });
    expect(parseGpuLine("browserGpuMode probe → software")).toEqual({
      mode: "software",
      renderer: null,
    });
    expect(parseGpuLine("nothing")).toEqual({ mode: "unknown", renderer: null });
  });
});
