import { describe, expect, it } from "vitest";
import {
  COMPACT_REPAIRS_BELOW,
  composeRequest,
  composeScene,
  draftToPlan,
  extractHtml,
  extractJson,
  findingScene,
  loadStyle,
  parseFps,
  planInsert,
  planProblems,
  staticSceneProblems,
  unsupportedTechniques,
  type PlanDraft,
  type PlanJob,
  type TextProvider,
  type TextRequest,
  type Transcript,
} from "../src/index.js";

/** Returns scripted replies in order and records every request. */
function fakeProvider(
  replies: string[],
  vision = true,
): TextProvider & { requests: TextRequest[] } {
  const requests: TextRequest[] = [];
  return {
    name: "fake",
    model: "fake-1",
    capabilities: { vision, structuredOutput: false, contextWindow: 200_000 },
    requests,
    async complete(req) {
      requests.push(structuredClone(req));
      const text = replies.shift();
      if (text === undefined) throw new Error("no more scripted replies");
      return { text, model: "fake-1", usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
}

const job: PlanJob = {
  style: "kil-lacivert",
  mode: "fullscreen",
  format: "landscape",
  width: 1920,
  height: 1080,
  fps: parseFps("30000/1001"),
  handlesFrames: 24,
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

function draft(overrides: Partial<PlanDraft["scenes"][number]>[] = [{}, {}]): PlanDraft {
  const base = [
    { start_s: 0, end_s: 5.1 },
    { start_s: 5.1, end_s: 10 },
  ];
  return {
    topic: "steps",
    summary: "three steps",
    scenes: overrides.map((o, i) => ({
      id: `s${i + 1}`,
      ...(base[i] ?? { start_s: i * 3, end_s: i * 3 + 3 }),
      anchor_words: ["adımda"],
      visual: "clay tokens drop",
      on_screen_text: "ÜÇ ADIMDA",
      camera: "slow push in",
      technique: "three-3d" as const,
      transition_out: "cut",
      sfx: [{ at_s: (base[i]?.start_s ?? 0) + 0.8, sound: "thock", gain_db: -12 }],
      ...o,
    })),
  };
}

describe("draftToPlan", () => {
  it("turns seconds into contiguous frames that cover the whole insert", () => {
    const plan = draftToPlan(draft(), job, 10);
    expect(plan.duration_frames).toBe(300);
    expect(plan.scenes.map((s) => [s.start_frame, s.end_frame])).toEqual([
      [0, 152],
      [152, 300],
    ]);
    expect(plan.scenes[1]?.sfx[0]?.frame).toBe(176);
    expect(plan.handles_frames).toBe(24);
  });

  it("repairs gaps, overlaps and cues outside their scene", () => {
    const plan = draftToPlan(
      draft([
        { start_s: 0.4, end_s: 6, sfx: [{ at_s: 9, sound: "pop", gain_db: 3 }] },
        { start_s: 5, end_s: 8 },
      ]),
      job,
      10,
    );
    expect(plan.scenes[0]?.start_frame).toBe(0);
    expect(plan.scenes[1]?.start_frame).toBe(plan.scenes[0]?.end_frame);
    expect(plan.scenes[1]?.end_frame).toBe(300);
    expect(plan.scenes[0]?.sfx[0]).toEqual({
      frame: (plan.scenes[0]?.end_frame ?? 0) - 1,
      type: "pop",
      gain_db: 0,
    });
  });
});

describe("style rules", () => {
  it("reads unsupported techniques from style.md", () => {
    expect(unsupportedTechniques(loadStyle("kil-lacivert").styleMd)).toEqual(["canvas-draw"]);
    expect(loadStyle("kinetik-tipografi").unsupported).toEqual(
      expect.arrayContaining(["three-3d", "ui-mockup"]),
    );
  });

  it("collects every font of a style, including font sets", () => {
    expect(loadStyle("kolaj-halftone").fonts.map((f) => f.family)).toEqual(
      expect.arrayContaining(["Archivo", "Anton", "Alfa Slab One"]),
    );
  });

  it("flags unsupported techniques and unknown sounds", () => {
    const style = loadStyle("kinetik-tipografi");
    const problems = planProblems(
      draft([{ technique: "three-3d" }, { sfx: [{ at_s: 6, sound: "thock", gain_db: -10 }] }]),
      style,
    );
    expect(problems.some((p) => p.includes('"three-3d" is not supported'))).toBe(true);
    expect(problems.some((p) => p.includes('sound "thock" is not in the palette'))).toBe(true);
  });
});

describe("planInsert", () => {
  it("feeds problems back until the plan is valid", async () => {
    const provider = fakeProvider([
      "Sure! Here is the plan:",
      JSON.stringify(draft([{ sfx: [{ at_s: 1, sound: "laser", gain_db: -10 }] }, {}])),
      "```json\n" + JSON.stringify(draft()) + "\n```",
    ]);
    const plan = await planInsert({ provider, transcript, style: loadStyle("kil-lacivert"), job });
    expect(plan.scenes).toHaveLength(2);
    expect(provider.requests).toHaveLength(3);
    const lastUser = provider.requests[2]?.messages.at(-1)?.content[0];
    expect(lastUser?.type === "text" && lastUser.text).toContain('sound "laser"');
    const first = provider.requests[0]?.messages[0]?.content[0];
    expect(first?.type === "text" && first.text).toContain("0.80-1.30 adımda");
  });

  it("gives up after three attempts with the last problems", async () => {
    const provider = fakeProvider(["no", "still no", "nope"]);
    await expect(
      planInsert({ provider, transcript, style: loadStyle("kil-lacivert"), job }),
    ).rejects.toThrow(/3 attempts/);
  });
});

describe("compose", () => {
  const style = loadStyle("kil-lacivert");
  const plan = draftToPlan(draft(), job, 10);
  const golden = style.examples["three-3d"] as string;

  it("accepts the golden kil-lacivert scene and rejects broken ones", () => {
    expect(staticSceneProblems(golden, "s1")).toEqual([]);
    const broken = golden
      .replace("mulberry(7)", "Math.random()")
      .replace('src="vendor', 'src="https://cdn.example.com');
    const problems = staticSceneProblems(broken.replaceAll('"s1"', '"x"'), "s1");
    expect(problems.join("\n")).toMatch(/Math.random/);
    expect(problems.join("\n")).toMatch(/__timelines/);
  });

  it("rejects scripts that look up the root by its id, which is gone once mounted", () => {
    const scene = (js: string) =>
      `<template><div id="s4-root" data-composition-id="s4" data-width="1920" data-height="1080"><canvas id="s4-gl"></canvas></div><script type="module">${js} window.__timelines["s4"] = tl;</script></template>`;
    const rootLookup = /looks up the root by its id "s4-root"/;
    expect(
      staticSceneProblems(scene('const root = document.getElementById("s4-root");'), "s4").join(),
    ).toMatch(rootLookup);
    expect(
      staticSceneProblems(scene("const root = document.querySelector('#s4-root');"), "s4").join(),
    ).toMatch(rootLookup);
    expect(
      staticSceneProblems(
        scene(
          'const c = document.getElementById("s4-gl"); const r = document.querySelector(\'[data-composition-id="s4"]\'); const x = document.querySelector("#s4-root-label");',
        ),
        "s4",
      ),
    ).toEqual([]);
  });

  it("rejects showing elements with visibility, which leaks past the scene's end", () => {
    const scene = (js: string) =>
      `<template><div id="root" data-composition-id="s3" data-width="720" data-height="1280"></div><script>${js} window.__timelines["s3"] = tl;</script></template>`;
    expect(
      staticSceneProblems(scene('tl.set(piece, { visibility: "visible" }, 1);'), "s3").join(),
    ).toMatch(/use opacity/);
    expect(staticSceneProblems(scene("el.style.visibility = 'visible';"), "s3").join()).toMatch(
      /use opacity/,
    );
    expect(staticSceneProblems(scene("tl.to(el, { autoAlpha: 1 }, 1);"), "s3").join()).toMatch(
      /use opacity/,
    );
    expect(staticSceneProblems(scene("tl.to(el, { opacity: 1 }, 1);"), "s3")).toEqual([]);
  });

  it("accepts id=root and rejects a class on the root", () => {
    const scene = (attrs: string) =>
      `<template><div ${attrs} data-composition-id="s3" data-width="1920" data-height="1080"></div><script>window.__timelines["s3"] = tl;</script></template>`;
    expect(staticSceneProblems(scene('id="root"'), "s3")).toEqual([]);
    expect(staticSceneProblems(scene('class="s3-root"'), "s3").join()).toMatch(/class="s3-root"/);
  });

  it("sends stills only to vision models and includes the scene's words", () => {
    const withVision = composeRequest(
      { provider: fakeProvider([]), plan, transcript, style },
      plan.scenes[1]!,
    );
    expect(withVision.filter((p) => p.type === "image")).toHaveLength(style.stills.length);
    const text = withVision.at(-1);
    expect(text?.type === "text" && text.text).toContain("0.13 video");
    const noVision = composeRequest(
      { provider: fakeProvider([], false), plan, transcript, style },
      plan.scenes[1]!,
    );
    expect(noVision.some((p) => p.type === "image")).toBe(false);
  });

  it("repairs a scene that breaks the contract", async () => {
    const good = golden.replaceAll("s1", "s2");
    const provider = fakeProvider([
      "```html\n" + good.replace("mulberry(7)", "Math.random()") + "\n```",
      "```html\n" + good + "\n```",
    ]);
    const result = await composeScene({ provider, plan, transcript, style }, plan.scenes[1]!);
    expect(result.html).toContain('data-composition-id="s2"');
    expect(provider.requests).toHaveLength(2);
  });

  const broken = (n: number) =>
    "```html\n" +
    golden.replaceAll("s1", "s2").replace("mulberry(7)", `Math.random() /* v${n} */`) +
    "\n```";
  const texts = (req: TextRequest) =>
    req.messages.map((m) =>
      m.content.map((p) => (p.type === "text" ? p.text : "[image]")).join(""),
    );

  it("keeps the whole conversation in repairs for a large or unknown context", async () => {
    const good = "```html\n" + golden.replaceAll("s1", "s2") + "\n```";
    const provider = fakeProvider([broken(1), broken(2), good]);
    await composeScene({ provider, plan, transcript, style }, plan.scenes[1]!);
    const last = provider.requests[2]!;
    expect(last.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    expect(texts(last).some((t) => t.includes("v1"))).toBe(true);
  });

  it("sends only the request, the latest HTML and its problems when the loaded context is small", async () => {
    const good = "```html\n" + golden.replaceAll("s1", "s2") + "\n```";
    const provider = Object.assign(fakeProvider([broken(1), broken(2), good]), {
      loadedContext: async () => COMPACT_REPAIRS_BELOW - 1,
    });
    const result = await composeScene({ provider, plan, transcript, style }, plan.scenes[1]!);
    const last = provider.requests[2]!;
    expect(last.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(last.messages[0]).toEqual(provider.requests[0]!.messages[0]);
    expect(texts(last)[1]).toContain("v2");
    expect(texts(last).some((t) => t.includes("v1"))).toBe(false);
    expect(result.messages).toHaveLength(4);
  });

  it("keeps the whole conversation when the loaded context is large", async () => {
    const good = "```html\n" + golden.replaceAll("s1", "s2") + "\n```";
    const provider = Object.assign(fakeProvider([broken(1), broken(2), good]), {
      loadedContext: async () => COMPACT_REPAIRS_BELOW,
    });
    await composeScene({ provider, plan, transcript, style }, plan.scenes[1]!);
    expect(provider.requests[2]!.messages).toHaveLength(5);
  });
});

describe("AnthropicProvider.preflight", () => {
  it("stops early without credentials and passes with a key", async () => {
    const { AnthropicProvider } = await import("../src/index.js");
    const saved = { ...process.env };
    for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE"])
      delete process.env[k];
    process.env.XDG_CONFIG_HOME = "/nonexistent-config-dir";
    try {
      expect(() => new AnthropicProvider({ model: "m", effort: "high" }).preflight()).toThrow(
        /ANTHROPIC_API_KEY/,
      );
      expect(() =>
        new AnthropicProvider({ model: "m", effort: "high", apiKey: "k" }).preflight(),
      ).not.toThrow();
      process.env.ANTHROPIC_API_KEY = "k";
      expect(() => new AnthropicProvider({ model: "m", effort: "high" }).preflight()).not.toThrow();
    } finally {
      process.env = saved;
    }
  });
});

describe("UsageMeter", () => {
  it("adds cache tokens to the total", async () => {
    const { UsageMeter } = await import("../src/index.js");
    const meter = new UsageMeter();
    const p = meter.wrap({
      name: "f",
      model: "m",
      capabilities: { vision: false, structuredOutput: false, contextWindow: 1 },
      complete: async () => ({
        text: "",
        model: "m",
        usage: { inputTokens: 2, outputTokens: 3, cacheWriteTokens: 5, cacheReadTokens: 7 },
      }),
    });
    await p.complete({ system: "", messages: [], maxTokens: 1, purpose: "a" });
    await p.complete({ system: "", messages: [], maxTokens: 1, purpose: "b" });
    expect(meter.total()).toEqual({
      inputTokens: 4,
      outputTokens: 6,
      cacheWriteTokens: 10,
      cacheReadTokens: 14,
      listPriceUsd: 0,
    });
  });
});

describe("helpers", () => {
  it("extracts JSON and HTML from model replies", () => {
    expect(extractJson('Here:\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(() => extractJson("nothing")).toThrow(/no JSON/);
    expect(extractHtml("```html\n<template><div></div></template>\n```")).toContain("<template>");
    expect(() => extractHtml("<div>no template</div>")).toThrow(/template/);
  });

  it("maps HyperFrames findings to scenes", () => {
    const ids = ["s1", "s2"];
    expect(
      findingScene(
        { severity: "error", message: "m", sourceFile: "/x/project/compositions/s2.html" },
        ids,
      ),
    ).toBe("s2");
    expect(
      findingScene({ severity: "error", message: "m", selector: "#s1-headline > span" }, ids),
    ).toBe("s1");
    expect(findingScene({ severity: "error", message: "m" }, ids)).toBeNull();
    const runtime = { severity: "error" as const, sourceFile: "/x/project/index.html" };
    expect(
      findingScene(
        { ...runtime, message: "s2 build error TypeError: Cannot read properties of null" },
        ids,
      ),
    ).toBe("s2");
    expect(findingScene({ ...runtime, message: "element #s1-card is null" }, ids)).toBe("s1");
    expect(findingScene({ ...runtime, message: "s1 and s2 both failed" }, ids)).toBeNull();
    expect(
      findingScene(
        { ...runtime, message: "Cannot read properties of null (reading 'style')" },
        ids,
      ),
    ).toBeNull();
  });
});

describe("ClaudeCodeProvider", () => {
  it("folds a conversation into one prompt and points at reference images", async () => {
    const { conversationPrompt } = await import("../src/index.js");
    const single = conversationPrompt(
      [{ role: "user", content: [{ type: "text", text: "plan this" }] }],
      [[]],
    );
    expect(single).toBe("plan this");
    const folded = conversationPrompt(
      [
        { role: "user", content: [{ type: "text", text: "write s1" }] },
        { role: "assistant", content: [{ type: "text", text: "<html>v1</html>" }] },
        { role: "user", content: [{ type: "text", text: "fix the error" }] },
      ],
      [["/tmp/a.png"], [], []],
    );
    expect(folded).toContain("<user>\nReference images for this message");
    expect(folded).toContain("/tmp/a.png");
    expect(folded).toContain("<assistant>\n<html>v1</html>\n</assistant>");
    expect(folded.endsWith("fix the error")).toBe(true);
  });

  // the fake CLI is a shell script, which Windows cannot start
  it.skipIf(process.platform === "win32")(
    "runs a fake CLI and reads its JSON result and usage",
    async () => {
      const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const { ClaudeCodeProvider } = await import("../src/index.js");
      const dir = mkdtempSync(join(tmpdir(), "mi-fakeclaude-"));
      const bin = join(dir, "claude");
      writeFileSync(
        bin,
        `#!/bin/sh\ncat > "${dir}/stdin.txt"\necho "$@" > "${dir}/args.txt"\necho '{"type":"result","subtype":"success","is_error":false,"result":"ok","total_cost_usd":0.5,"usage":{"input_tokens":3,"output_tokens":4,"cache_creation_input_tokens":5,"cache_read_input_tokens":6},"modelUsage":{"claude-sonnet-5-5":{}}}'\n`,
      );
      chmodSync(bin, 0o755);
      const saved = process.env.KILNFRAME_CLAUDE;
      process.env.KILNFRAME_CLAUDE = bin;
      try {
        const p = new ClaudeCodeProvider({ model: "claude-sonnet-5-5", effort: "high" });
        const r = await p.complete({
          system: "SYS",
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          maxTokens: 10,
          purpose: "t",
        });
        expect(r).toEqual({
          text: "ok",
          model: "claude-sonnet-5-5",
          usage: {
            inputTokens: 3,
            outputTokens: 4,
            cacheWriteTokens: 5,
            cacheReadTokens: 6,
            listPriceUsd: 0.5,
          },
        });
        const { readFileSync } = await import("node:fs");
        expect(readFileSync(join(dir, "stdin.txt"), "utf8")).toBe("hi");
        expect(readFileSync(join(dir, "args.txt"), "utf8")).toContain("--system-prompt SYS");
        expect(p.billing).toBe("plan");
      } finally {
        if (saved === undefined) delete process.env.KILNFRAME_CLAUDE;
        else process.env.KILNFRAME_CLAUDE = saved;
      }
    },
  );
});

describe("timeline registration", () => {
  it("accepts the scene id written out, by dot or through a variable", async () => {
    const { registersTimeline } = await import("../src/index.js");
    expect(registersTimeline('window.__timelines["s2"] = tl;', "s2")).toBe(true);
    expect(registersTimeline("window.__timelines['s2']=tl", "s2")).toBe(true);
    expect(registersTimeline("window.__timelines.s2 = tl;", "s2")).toBe(true);
    // MiniMax M3, 9 Oct 2026
    expect(
      registersTimeline('const SCENE_ID = "s2";\n window.__timelines[SCENE_ID] = tl;', "s2"),
    ).toBe(true);
  });

  it("still rejects a missing or wrong registration", async () => {
    const { registersTimeline } = await import("../src/index.js");
    expect(
      registersTimeline('const SCENE_ID = "s3"; window.__timelines[SCENE_ID] = tl;', "s2"),
    ).toBe(false);
    expect(registersTimeline("window.__timelines[id] = tl;", "s2")).toBe(false);
    expect(registersTimeline('if (window.__timelines["s2"] === tl) {}', "s2")).toBe(false);
    expect(registersTimeline('window.__timelines["s21"] = tl;', "s2")).toBe(false);
  });
});

describe("turned-down replies", () => {
  it("are kept with their problems", async () => {
    const { keepRejected } = await import("../src/index.js");
    const { mkdtempSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = join(mkdtempSync(join(tmpdir(), "mi-rej-")), "rejected");
    keepRejected(dir, "s2-attempt-1", "<html>…</html>", ["The scene must register it."]);
    const text = readFileSync(join(dir, "s2-attempt-1.txt"), "utf8");
    expect(text).toContain("The scene must register it.");
    expect(text).toContain("<html>…</html>");
    expect(() => keepRejected(undefined, "x", "y", [])).not.toThrow();
  });
});

describe("overlay haze", () => {
  it("turns down grain in an overlay scene and keeps it in a fullscreen one", async () => {
    const { staticSceneProblems } = await import("../src/index.js");
    const grain =
      '<template><div data-composition-id="s1"><svg id="s1-grain"><filter id="s1-noise"><feTurbulence type="fractalNoise"/></filter></svg></div><script>window.__timelines["s1"] = tl;</script></template>';
    expect(staticSceneProblems(grain, "s1", [], true).some((p) => p.includes("haze"))).toBe(true);
    expect(staticSceneProblems(grain, "s1", [], false).some((p) => p.includes("haze"))).toBe(false);
  });
});
