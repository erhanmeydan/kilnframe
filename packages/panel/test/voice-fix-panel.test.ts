import { describe, expect, it } from "vitest";
import { newVoiceFix, voiceFixAct, voiceFixBox, type VoiceFixState } from "../src/voice-fix";

const SEQ = {
  id: "seq-1",
  name: "Talk",
  projectPath: "/p/a.prproj",
  fps: "25",
  fpsValue: 25,
  width: 1920,
  height: 1080,
  inSeconds: 200,
  outSeconds: 203,
  endSeconds: 300,
  videoTracks: 1,
  audioTracks: 2,
};

const tick = () => new Promise((r) => setTimeout(r, 0));

type Msg = { type: string; params?: Record<string, unknown>; [k: string]: unknown };

/** A panel around the tab: records what goes to the companion and to the editor. */
function fakeCtx(o: { stored?: Record<string, string>; tracks?: number[]; offset?: number } = {}) {
  const sent: Msg[] = [];
  const exports: unknown[][] = [];
  const forgotten: string[] = [];
  const store: Record<string, string> = { ...(o.stored ?? {}) };
  let listener: (m: Record<string, unknown>) => void = () => undefined;
  const ctx = {
    esc: (s: string) => s,
    reportLink: () => "",
    render: () => undefined,
    trace: () => undefined,
    connected: () => true,
    inOut: () => ({ startS: 200, endS: 203, durationS: 3, source: "inout", warning: null }),
    rangeLine: () => "",
    readSequence: async () => SEQ,
    request: async (m: Msg) => {
      sent.push(m);
      if (m.type === "job.prepare") return { jobDir: "/j" };
      if (m.type === "job.start") return { jobId: `job-${sent.length}` };
      return {};
    },
    send: (m: Msg) => sent.push(m),
    on: (fn: typeof listener) => ((listener = fn), () => undefined),
    speechTracksAt: async () => o.tracks ?? [0],
    withOnlyAudioTrack: async (_s: unknown, _t: number, fn: () => Promise<unknown>) => ({
      result: await fn(),
      isolated: true,
    }),
    exportAudio: async (...args: unknown[]) => {
      exports.push(args.slice(1));
      return { ok: true, offsetSeconds: o.offset ?? 0 };
    },
    renderSettingsLost: async () => false,
    placeClips: async () => ({ audioTrack: 2 }),
    stored: (k: string) => store[k] ?? null,
    store: (k: string, v: string) => void (store[k] = v),
    forget: (k: string) => {
      forgotten.push(k);
      delete store[k];
    },
  };
  return {
    ctx: ctx as never,
    sent,
    exports,
    forgotten,
    store,
    emit: (m: Record<string, unknown>) => listener(m),
  };
}

function atStage(stage: VoiceFixState["stage"], extra: Partial<VoiceFixState> = {}) {
  return {
    ...newVoiceFix(),
    stage,
    keySet: true,
    seqId: "seq-1",
    seqName: "Talk",
    track: 0,
    fixStartS: 200,
    fixEndS: 203,
    jobDir: "/j",
    windowFile: "/j/voice-fix/window.wav",
    text: "geliyor 17",
    before: "Önce.",
    after: "Sonra.",
    language: "tr",
    sample: {
      spans: [
        { startS: 10, endS: 70 },
        { startS: 190, endS: 230 },
      ],
      speechS: 95,
    },
    ...extra,
  } as VoiceFixState;
}

const jobs = (sent: Msg[]) => sent.filter((m) => m.type === "job.start").map((m) => m.params!);

describe("voice fix panel", () => {
  it("asks for consent with the one-speaker note and a way to hear the sample first", () => {
    const { ctx } = fakeCtx();
    const html = voiceFixBox(atStage("consent"), ctx);
    expect(html).toContain("only your voice");
    expect(html).toContain("Listen To Sample");
    expect(html).toContain('data-act="fix-sample"');
    expect(html).toContain("This is my voice, or I have the right and consent to clone it.");
  });

  it("does not clone before the consent box is ticked", async () => {
    const { ctx, sent } = fakeCtx();
    const st = atStage("consent");
    expect(voiceFixAct(st, ctx, "fix-clone", "")).toBe(true);
    await tick();
    expect(st.error).toBe("Confirm that the voice is yours or that you may clone it.");
    expect(st.stage).toBe("consent");
    expect(sent).toEqual([]);
  });

  it("clones from the spans around the range once consent is given, remembers the voice, then reads", async () => {
    const { ctx, sent, store } = fakeCtx();
    const st = atStage("consent");
    voiceFixAct(st, ctx, "fix-consent", "");
    (ctx as unknown as { request: (m: Msg) => Promise<unknown> }).request = async (m: Msg) => {
      sent.push(m);
      if (m.type === "speech.clone") return { voice: "v-new", name: "Kilnframe: Talk" };
      return { jobId: "j9" };
    };
    voiceFixAct(st, ctx, "fix-clone", "");
    await tick();
    await tick();
    const clone = sent.find((m) => m.type === "speech.clone")!;
    expect(clone).toMatchObject({
      audioPath: "/j/voice-fix/window.wav",
      spans: atStage("consent").sample!.spans,
      name: "Kilnframe: Talk",
      consent: true,
    });
    expect(clone).not.toHaveProperty("rangeStartS");
    expect(store["voice-clone:seq-1:0"]).toBe("v-new");
    expect(jobs(sent)[0]).toMatchObject({ kind: "voice-fix-say", voice: "v-new", take: 1 });
    expect(st.stage).toBe("saying");
  });

  it("sends the edited text exactly as typed", async () => {
    const { ctx, sent } = fakeCtx({ stored: { "voice-clone:seq-1:0": "v1" } });
    const st = atStage("edit", { text: "geliyo  17" });
    voiceFixAct(st, ctx, "fix-say", "");
    await tick();
    const say = jobs(sent)[0]!;
    expect(say.text).toBe("geliyo  17");
    expect(say).toMatchObject({
      kind: "voice-fix-say",
      voice: "v1",
      outDir: "/j/voice-fix",
      take: 1,
      before: "Önce.",
      after: "Sonra.",
      language: "tr",
    });
    expect(say).not.toHaveProperty("style");
  });

  it("says so and sends nothing when the text is empty", async () => {
    const { ctx, sent } = fakeCtx({ stored: { "voice-clone:seq-1:0": "v1" } });
    const st = atStage("edit", { text: "   " });
    voiceFixAct(st, ctx, "fix-say", "");
    await tick();
    expect(st.error).toMatch(/Write the text/);
    expect(st.stage).toBe("edit");
    expect(sent).toEqual([]);
  });

  it("forgets a clone ElevenLabs no longer has and asks to clone again", async () => {
    const { ctx, emit, forgotten, store } = fakeCtx({ stored: { "voice-clone:seq-1:0": "v1" } });
    const st = atStage("edit");
    voiceFixAct(st, ctx, "fix-say", "");
    await tick();
    expect(st.stage).toBe("saying");
    emit({
      type: "job.error",
      jobId: st.jobId,
      message: "ElevenLabs could not find this voice: voice_not_found",
    });
    expect(forgotten).toEqual(["voice-clone:seq-1:0"]);
    expect(store["voice-clone:seq-1:0"]).toBeUndefined();
    expect(st.stage).toBe("consent");
  });

  it("with a remembered clone goes from Fix This Part to the text and straight on to reading it", async () => {
    const { ctx, sent, exports, emit } = fakeCtx({
      stored: { "voice-clone:seq-1:0": "v1" },
      offset: 20,
    });
    const st = { ...newVoiceFix(), keySet: true };
    voiceFixAct(st, ctx, "fix-go", "");
    await tick();
    await tick();
    // the window: 180 s before In (200 - 180) and 180 s after Out, clamped to the sequence's end
    // exported to the job folder (which exists); the companion cuts the window into voice-fix/
    expect(exports[0]).toEqual([20, 300, "/j/export.wav"]);
    expect(sent.find((m) => m.type === "job.prepare")).toMatchObject({ sequenceName: "Voice Fix" });
    const read = jobs(sent)[0]!;
    // times count from the exported file's start
    expect(read).toEqual({
      kind: "voice-fix-read",
      audioPath: "/j/export.wav",
      fixStartS: 180,
      fixEndS: 183,
      windowStartS: 0,
      windowEndS: 280,
      outDir: "/j/voice-fix",
    });
    emit({
      type: "job.done",
      jobId: st.jobId,
      result: {
        kind: "voice-fix-read",
        text: "geliyor 17",
        before: "",
        after: "",
        language: "tr",
        sample: { spans: [{ startS: 0, endS: 90 }], speechS: 88 },
        windowPath: "/j/voice-fix/window.wav",
      },
    });
    expect(st.stage).toBe("edit");
    // the sample spans count from the window the companion cut: the clone reads that file
    expect(st.windowFile).toBe("/j/voice-fix/window.wav");
    expect(st.text).toBe("geliyor 17");
    voiceFixAct(st, ctx, "fix-say", "");
    await tick();
    expect(st.stage).toBe("saying");
    expect(jobs(sent)[1]).toMatchObject({ kind: "voice-fix-say", voice: "v1", text: "geliyor 17" });
  });

  it("asks which track holds the voice when more than one has sound under the range", async () => {
    const { ctx, sent } = fakeCtx({ tracks: [0, 2] });
    const st = { ...newVoiceFix(), keySet: true };
    voiceFixAct(st, ctx, "fix-go", "");
    await tick();
    await tick();
    expect(st.stage).toBe("track");
    expect(voiceFixBox(st, ctx)).toContain("A3");
    expect(jobs(sent)).toEqual([]);
    voiceFixAct(st, ctx, "fix-track", "2");
    await tick();
    await tick();
    expect(st.track).toBe(2);
    expect(jobs(sent)[0]).toMatchObject({ kind: "voice-fix-read" });
  });

  it("switches to another part when the speech around the range is too short for a clone", () => {
    const { ctx } = fakeCtx();
    const st = atStage("edit", { sample: { spans: [{ startS: 0, endS: 20 }], speechS: 20 } });
    voiceFixAct(st, ctx, "fix-say", "");
    expect(st.stage).toBe("consent");
    expect(st.source).toBe("other");
    expect(voiceFixBox(st, ctx)).toMatch(/20 s/);
  });

  it("refuses to clone or cut a sample from too little speech around, also when chosen again", async () => {
    const { ctx, sent } = fakeCtx();
    const st = atStage("edit", { sample: { spans: [{ startS: 0, endS: 20 }], speechS: 20 } });
    voiceFixAct(st, ctx, "fix-say", "");
    expect(st.source).toBe("other");
    voiceFixAct(st, ctx, "fix-source", "around");
    voiceFixAct(st, ctx, "fix-sample", "");
    await tick();
    expect(st.error).toMatch(/Only 20 s of your speech/);
    voiceFixAct(st, ctx, "fix-consent", "");
    voiceFixAct(st, ctx, "fix-clone", "");
    await tick();
    expect(st.stage).toBe("consent");
    expect(st.error).toMatch(/Only 20 s of your speech/);
    expect(sent).toEqual([]);
  });

  it("clones from another part the editor marked, exported fresh from the same track", async () => {
    const { ctx, sent, exports } = fakeCtx();
    (ctx as unknown as { inOut: () => unknown }).inOut = () => ({
      startS: 10,
      endS: 80,
      durationS: 70,
      source: "inout",
      warning: null,
    });
    const st = atStage("consent", { source: "other", consent: true });
    voiceFixAct(st, ctx, "fix-clone", "");
    await tick();
    await tick();
    expect(exports[0]).toEqual([10, 80, "/j/other.wav"]);
    const clone = sent.find((m) => m.type === "speech.clone")!;
    expect(clone).toMatchObject({
      audioPath: "/j/other.wav",
      rangeStartS: 10,
      rangeEndS: 80,
    });
    expect(clone).not.toHaveProperty("spans");
  });

  it("cuts the sample for listening without consent and plays it", async () => {
    const { ctx, sent } = fakeCtx();
    (ctx as unknown as { request: (m: Msg) => Promise<unknown> }).request = async (m: Msg) => {
      sent.push(m);
      return m.type === "speech.clone" ? { sample: "/j/voice-fix/voice-sample.wav" } : {};
    };
    const st = atStage("consent");
    voiceFixAct(st, ctx, "fix-sample", "");
    await tick();
    await tick();
    const dry = sent.find((m) => m.type === "speech.clone")!;
    expect(dry).toMatchObject({ audioPath: "/j/voice-fix/window.wav", dryRun: true });
    expect(dry).not.toHaveProperty("consent");
    expect(sent.find((m) => m.type === "audio.play")).toEqual({
      type: "audio.play",
      file: "/j/voice-fix/voice-sample.wav",
    });
    expect(st.playing).toBe("sample");
  });

  it("refuses another part that overlaps the range being fixed", async () => {
    const { ctx, sent } = fakeCtx();
    const st = atStage("consent", { source: "other", consent: true });
    voiceFixAct(st, ctx, "fix-clone", "");
    await tick();
    expect(st.stage).toBe("consent");
    expect(st.error).toMatch(/another part/i);
    expect(sent).toEqual([]);
  });

  it("places the take at In on a new track and tells where", async () => {
    const { ctx } = fakeCtx();
    let placed: unknown = null;
    (ctx as unknown as { placeClips: unknown }).placeClips = async (_s: unknown, c: unknown) => {
      placed = c;
      return { audioTrack: 2 };
    };
    const st = atStage("listen", {
      take: 1,
      result: { file: "/j/voice-fix/take-1.wav", durationS: 3.4, priceUsd: 0.01 },
    });
    expect(voiceFixBox(st, ctx)).toMatch(/0\.4 s longer/);
    voiceFixAct(st, ctx, "fix-place", "");
    await tick();
    await tick();
    expect(st.error).toBeNull();
    expect(placed).toEqual([{ file: "/j/voice-fix/take-1.wav", atS: 200, durationS: 3.4 }]);
    expect(st.stage).toBe("placed");
    expect(voiceFixBox(st, ctx)).toContain("Placed on A3.");
  });
});
