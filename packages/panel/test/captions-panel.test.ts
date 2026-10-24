import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captionsAct,
  captionsBox,
  captionsColorInput,
  captionsLineInput,
  captionsReconnected,
  captionsSwitch,
  caretWord,
  stillWindow,
  newCaptions,
  typedColors,
  type CaptionsCtx,
  type CaptionsState,
} from "../src/captions";
import { setLang, t } from "../src/i18n";
import en from "../src/locales/en.json";
import tr from "../src/locales/tr.json";
import { watchesSequence } from "../src/music";
import { MAX_MESSAGE_BYTES } from "../src/companion";
import { MAX_MESSAGE_BYTES as COMPANION_MAX } from "../../companion/src/protocol";
import { msTimes, unpackLines, type PackedLine } from "../../core/src/captions/pack";
import { longWords } from "../../core/test/long-talk";

const tick = () => new Promise((r) => setTimeout(r, 0));
/** Lets the preview chain (sequence, folder, frame, job) run its awaits. */
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

const seq = {
  id: "seq-1",
  name: "Talk",
  projectPath: "/p/Talk.prproj",
  fps: "25",
  fpsValue: 25,
  width: 1080,
  height: 1920,
  inSeconds: 0,
  outSeconds: 0,
  endSeconds: 60,
  videoTracks: 2,
  audioTracks: 2,
};

const words = [
  { text: "Bugün", start: 0.2, end: 0.5 },
  { text: "Topview'i", start: 0.55, end: 1.0 },
  { text: "deneyeceğiz.", start: 1.05, end: 1.6 },
  { text: "Hadi", start: 3.0, end: 3.3 },
  { text: "başlayalım.", start: 3.35, end: 3.9 },
];

type Listener = (m: Record<string, unknown>) => void;

/** A panel stand-in that records what the tab asks for; jobs finish when the test says so. */
function fakeCtx(over: Partial<CaptionsCtx> = {}) {
  const sent: Record<string, unknown>[] = [];
  const placed: unknown[][] = [];
  const replaced: unknown[][] = [];
  const written: [string, string][] = [];
  const store: Record<string, string> = {};
  /** captions.json per job folder, as the companion keeps it. */
  const disk: Record<string, Record<string, unknown>> = {};
  const prepared: string[] = [];
  /** Every request as it would go over the socket. */
  const requests: Record<string, unknown>[] = [];
  const listeners = new Set<Listener>();
  const frames: number[] = [];
  const frameCalls: {
    seconds: number;
    name: string;
    width: number;
    height: number;
    hidden: boolean;
  }[] = [];
  const hidden: { startS: number; endS: number }[] = [];
  let hiding = false;
  let jobs = 0;
  const ctx: CaptionsCtx = {
    esc: (s) => s,
    reportLink: () => "",
    seg: (name, value, options) =>
      options.map(([v, label]) => `[${name}:${v}${v === value ? " on" : ""}]${label}`).join(""),
    render: () => undefined,
    trace: () => undefined,
    connected: () => true,
    inOut: () => null,
    rangeLine: () => "",
    videoStyle: () => null,
    tileWidth: () => 100,
    readSequence: async () => seq,
    request: async (m) => {
      const msg = m as Record<string, unknown>;
      requests.push(msg);
      if (msg.type === "job.prepare") {
        prepared.push(String(msg.sequenceName));
        return { type: "job.prepared", jobDir: "/j/cap" };
      }
      if (msg.type === "captions.previews")
        return { type: "captions.previews", dir: "/kf/previews" };
      if (msg.type === "captions.save") {
        const dir = String(msg.jobDir);
        disk[dir] = { ...disk[dir], panel: JSON.parse(JSON.stringify(msg.state)) };
        return { type: "captions.saved", jobDir: dir };
      }
      if (msg.type === "captions.load")
        return { type: "captions.loaded", state: disk[String(msg.jobDir)] ?? null };
      if (msg.type === "job.start") {
        // the doc's lines travel packed; the tests read them as lines
        const params = msg.params as Record<string, unknown> & { doc?: { lines: PackedLine[] } };
        sent.push(
          params.doc
            ? { ...params, doc: { ...params.doc, lines: unpackLines(params.doc.lines) } }
            : params,
        );
        return { type: "job.accepted", jobId: `job-${++jobs}` };
      }
      return { type: "ok" };
    },
    send: (m) => sent.push(m as Record<string, unknown>),
    on: (fn) => {
      listeners.add(fn as Listener);
      return () => listeners.delete(fn as Listener);
    },
    providerParams: () => ({ provider: "auto" }),
    withoutOurInserts: async (_s, r, fn) => {
      hidden.push({ startS: r.startS, endS: r.endS });
      hiding = true;
      try {
        return await fn();
      } finally {
        hiding = false;
      }
    },
    exportAudio: async () => ({ ok: true, offsetSeconds: 0 }),
    ourInsertSpans: async () => [{ startS: 10, endS: 14 }],
    placeInsert: async (...a) => {
      placed.push(a);
      return { videoTrack: 2, audioTrack: 2 };
    },
    findCaptionClip: async () => ({ videoTrack: 2 }),
    replaceCaptionClip: async (...a) => {
      replaced.push(a);
      return true;
    },
    caret: () => null,
    exportFrame: async (_s, seconds, dir, name, width, height) => {
      frames.push(seconds);
      frameCalls.push({ seconds, name, width, height, hidden: hiding });
      return `${dir}/frame-${frames.length}.png`;
    },
    playsVideo: () => false,
    img: (key, src, width, height) => `<slot key="${key}" src="${src}" w="${width}" h="${height}">`,
    refresh: () => undefined,
    swapImage: () => undefined,
    stored: (k) => store[k] ?? null,
    store: (k, v) => {
      store[k] = v;
    },
    saveFileCopy: async (source, name) => {
      written.push([source, name]);
      return `/Users/me/Desktop/${name}`;
    },
    ...over,
  };
  const emit = (m: Record<string, unknown>) => [...listeners].forEach((fn) => fn(m));
  const finish = (result: Record<string, unknown>, job = jobs) =>
    emit({ type: "job.done", jobId: `job-${job}`, result });
  const fail = (message: string, job = jobs) =>
    emit({ type: "job.error", jobId: `job-${job}`, message });
  const cancelled = (job: number) => emit({ type: "job.cancelled", jobId: `job-${job}` });
  return {
    ctx,
    sent,
    placed,
    replaced,
    written,
    store,
    disk,
    prepared,
    requests,
    frames,
    frameCalls,
    hidden,
    finish,
    fail,
    cancelled,
  };
}

const textResult = {
  kind: "captions-text",
  language: "tr",
  words,
  corrected: true,
  durationS: 60,
};

/** Runs step 1 through the text job, leaving the tab on review. */
async function toReview(
  f: ReturnType<typeof fakeCtx>,
  result: Record<string, unknown> = textResult,
) {
  const st = newCaptions();
  captionsAct(st, f.ctx, "captions-make", "");
  await tick();
  await tick();
  f.finish(result);
  return st;
}

afterEach(() => setLang("en"));

describe("captions tab", () => {
  it("names the four tabs short enough to fit", () => {
    expect(
      [en["tab.range"], en["tab.story"], en["tab.music"], en["tab.captions"]].join(" · "),
    ).toBe("Range · Story · Music · Captions");
    expect(
      [tr["tab.range"], tr["tab.story"], tr["tab.music"], tr["tab.captions"]].join(" · "),
    ).toBe("Aralık · Hikaye · Müzik · Altyazı");
  });

  it("shows the scope, the nine looks in grid order, the look's colours and the glossary", () => {
    setLang("tr");
    const f = fakeCtx({ videoStyle: () => "kil-lacivert" });
    const html = captionsBox(newCaptions(), f.ctx);
    expect(html).toContain("[captions-scope:all on]Tüm Sekans");
    const tiles = [...html.matchAll(/data-act="captions-look" data-val="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(tiles).toEqual([
      "kil-lacivert",
      "loud",
      "dinamik",
      "hap",
      "karaoke",
      "daktilo",
      "sakin",
      "bant",
      "editoryal",
    ]);
    // display names, never ids
    expect(html).toContain("Kil Lacivert");
    expect(html).toContain("Editoryal");
    expect(html).not.toMatch(/>kil-lacivert</);
    // the first look is selected and its colours are shown
    expect(html).toContain('id="cap-color-text"');
    expect(html).toContain("#efe8dd");
    expect(html).toContain("#d9875f");
    expect(html).toContain('id="cap-glossary"');
    expect(html).toContain("Altyazıyı Hazırla");
  });

  it("starts the grid with Band when the video is not Kil Lacivert", () => {
    const html = captionsBox(newCaptions(), fakeCtx().ctx);
    const tiles = [...html.matchAll(/data-act="captions-look" data-val="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(tiles[0]).toBe("bant");
    expect(tiles[7]).toBe("kil-lacivert");
  });

  it("offers the written or spoken choice only for Turkish speech", () => {
    const f = fakeCtx();
    const st = newCaptions();
    // no transcript yet: the panel's language decides
    expect(captionsBox(st, f.ctx)).not.toContain("captions-mode");
    setLang("tr");
    expect(captionsBox(st, f.ctx)).toContain("[captions-mode:written on]Yazım Kurallarına Göre");
    expect(captionsBox(st, f.ctx)).toContain("Konuşulduğu Gibi");
    // this sequence's last transcript was English: hidden even in a Turkish panel
    st.language = "en";
    expect(captionsBox(st, f.ctx)).not.toContain("captions-mode");
    setLang("en");
    st.language = "tr";
    expect(captionsBox(st, f.ctx)).toContain("captions-mode");
  });

  it("starts one text job however often Prepare Captions is clicked", async () => {
    const f = fakeCtx();
    const st = newCaptions();
    st.settings.glossary = ["TopView"];
    captionsAct(st, f.ctx, "captions-make", "");
    captionsAct(st, f.ctx, "captions-make", "");
    await tick();
    await tick();
    captionsAct(st, f.ctx, "captions-make", "");
    await tick();
    const jobs = f.sent.filter((p) => p.kind === "captions-text");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      kind: "captions-text",
      audioPath: "/j/cap/sequence.wav",
      rangeStartS: 0,
      rangeEndS: 60,
      outDir: "/j/cap",
      glossary: ["TopView"],
      mode: "written",
      provider: "auto",
    });
  });

  it("splits the words into lines for the look and the sequence's format, marking changed ones", async () => {
    const f = fakeCtx();
    const st = await toReview(f);
    expect(st.stage).toBe("review");
    expect(st.language).toBe("tr");
    expect(st.lines.map((l) => l.text)).toEqual([
      "Bugün Topview'i deneyeceğiz.",
      "Hadi başlayalım.",
    ]);
    // the last transcript's language is kept for this sequence
    expect(f.store["captions-lang:seq-1"]).toBe("tr");
    st.lines[1] = { ...st.lines[1]!, changed: true };
    const html = captionsBox(st, f.ctx);
    expect(html).toMatch(/class="cline changed"[^]*cap-line-1/);
    expect(html).not.toMatch(/class="cline changed"[^]*cap-line-0/);
  });

  it("wraps by the look's width for portrait", async () => {
    const f = fakeCtx();
    const st = newCaptions();
    // Calm is one line of up to 24 characters in portrait
    captionsAct(st, f.ctx, "captions-look", "sakin");
    captionsAct(st, f.ctx, "captions-make", "");
    await tick();
    await tick();
    f.finish(textResult);
    expect(st.lines.map((l) => l.text)).toEqual([
      "Bugün Topview'i",
      "deneyeceğiz.",
      "Hadi başlayalım.",
    ]);
  });

  it("marks the lines the correction changed against what Whisper heard", async () => {
    const f = fakeCtx();
    const heard = [
      { text: "Bugün", start: 0.2, end: 0.5 },
      { text: "Top", start: 0.55, end: 0.75 },
      { text: "View'e'nin", start: 0.75, end: 1.0 },
      { text: "deneyeceğiz.", start: 1.05, end: 1.6 },
      { text: "Hadi", start: 3.0, end: 3.3 },
      { text: "başlayalım.", start: 3.35, end: 3.9 },
    ];
    const st = await toReview(f, { ...textResult, original: heard });
    expect(st.lines.map((l) => l.changed)).toEqual([true, false]);
    // no correction: nothing to compare with, nothing marked
    const plain = await toReview(fakeCtx());
    expect(plain.lines.map((l) => l.changed)).toEqual([false, false]);
  });

  it("says in one line when the text could not be corrected, and goes on", async () => {
    const f = fakeCtx();
    const st = await toReview(f, { ...textResult, corrected: false, correctionError: "429" });
    expect(st.stage).toBe("review");
    const html = captionsBox(st, f.ctx);
    expect(html).toContain(t("captions.notCorrected"));
  });

  it("says there is nothing to caption when there is no speech, and stays on step 1", async () => {
    const f = fakeCtx();
    const st = newCaptions();
    captionsAct(st, f.ctx, "captions-make", "");
    await tick();
    await tick();
    f.fail("No speech was found in the audio.");
    expect(st.stage).toBe("idle");
    expect(st.error).toBeNull();
    expect(captionsBox(st, f.ctx)).toContain(t("captions.noSpeech"));
  });

  it("renders the edited text, drops emptied lines and hides the captions under animations", async () => {
    const f = fakeCtx();
    const st = await toReview(f);
    st.drafts[0] = "Bugün TopView'i deneyeceğiz.";
    st.drafts[1] = "  ";
    captionsAct(st, f.ctx, "captions-render", "");
    await tick();
    await tick();
    const job = f.sent.find((p) => p.kind === "captions-render") as Record<string, never>;
    expect(job).toBeDefined();
    const doc = job.doc as unknown as Record<string, unknown>;
    expect((doc.lines as { text: string }[]).map((l) => l.text)).toEqual([
      "Bugün TopView'i deneyeceğiz.",
    ]);
    expect((doc.lines as { start: number; end: number }[])[0]).toMatchObject({
      start: 0.2,
      end: 1.6,
    });
    expect(doc).toMatchObject({
      language: "tr",
      durationS: 60,
      width: 1080,
      height: 1920,
      fps: "25",
      hideSpans: [{ startS: 10, endS: 14 }],
    });
    expect(job).toMatchObject({ look: "bant", outDir: "/j/cap" });
  });

  it("shows the captions over animations too when the editor asks", async () => {
    const f = fakeCtx();
    const st = await toReview(f);
    captionsAct(st, f.ctx, "captions-over", "");
    captionsAct(st, f.ctx, "captions-render", "");
    await tick();
    await tick();
    const job = f.sent.find((p) => p.kind === "captions-render") as {
      doc: { hideSpans: unknown[] };
    };
    expect(job.doc.hideSpans).toEqual([]);
  });

  it("splits a line at the caret's word and joins it with the next, without a job", async () => {
    const f = fakeCtx({ caret: () => 8 }); // inside "Topview'i"
    const st = await toReview(f);
    const before = f.sent.length;
    captionsAct(st, f.ctx, "captions-split", "0");
    expect(st.lines.map((l) => l.text)).toEqual([
      "Bugün",
      "Topview'i deneyeceğiz.",
      "Hadi başlayalım.",
    ]);
    captionsAct(st, f.ctx, "captions-merge", "1");
    expect(st.lines.map((l) => l.text)).toEqual([
      "Bugün",
      "Topview'i deneyeceğiz. Hadi başlayalım.",
    ]);
    expect(st.drafts).toEqual(st.lines.map((l) => l.text));
    expect(f.sent.length).toBe(before);
    const html = captionsBox(st, f.ctx);
    expect(html).toContain(t("captions.split"));
    expect(html).toContain(t("captions.merge"));
  });

  it("finds the caret's word: the word it is in, else the next one, else the middle", () => {
    expect(caretWord("bir iki üç dört", 5)).toBe(1); // inside "iki"
    expect(caretWord("bir iki üç dört", 4)).toBe(1); // at the start of "iki"
    expect(caretWord("bir iki üç dört", 3)).toBe(1); // right after "bir"
    expect(caretWord("bir iki üç dört", null)).toBe(2);
    expect(caretWord("bir iki üç dört", 0)).toBe(2);
    expect(caretWord("bir iki", 100)).toBe(1);
  });

  it("places the first render on a new track, then replaces it where it was found", async () => {
    const f = fakeCtx();
    const st = await toReview(f);
    captionsAct(st, f.ctx, "captions-render", "");
    await tick();
    await tick();
    f.finish({
      kind: "captions-render",
      video: "/j/cap/captions-1.mov",
      srt: "/j/cap/captions-1.srt",
    });
    await tick();
    await tick();
    expect(f.placed).toEqual([[seq, { video: "/j/cap/captions-1.mov", sfx: null }, 0, 0, 60]]);
    expect(st.stage).toBe("placed");
    expect(captionsBox(st, f.ctx)).toContain(t("captions.placed", { v: 3 }));

    captionsAct(st, f.ctx, "captions-render", "");
    await tick();
    await tick();
    f.finish({
      kind: "captions-render",
      video: "/j/cap/captions-2.mov",
      srt: "/j/cap/captions-2.srt",
    });
    await tick();
    await tick();
    expect(f.replaced).toEqual([
      [
        seq,
        { path: "/j/cap/captions-1.mov", atS: 0, durationS: 60 },
        "/j/cap/captions-2.mov",
        0,
        60,
        2,
      ],
    ]);
    expect(f.placed).toHaveLength(1);
    expect(st.placed?.video).toBe("/j/cap/captions-2.mov");
  });

  it("puts a re-render on a new track and says so when the earlier clip was moved or trimmed", async () => {
    const f = fakeCtx({ findCaptionClip: async () => null });
    const st = await toReview(f);
    st.placed = {
      video: "/j/cap/captions-1.mov",
      srt: "/j/cap/captions-1.srt",
      atS: 0,
      durationS: 60,
      videoTrack: 2,
    };
    captionsAct(st, f.ctx, "captions-render", "");
    await tick();
    await tick();
    f.finish({
      kind: "captions-render",
      video: "/j/cap/captions-2.mov",
      srt: "/j/cap/captions-2.srt",
    });
    await tick();
    await tick();
    expect(f.replaced).toEqual([]);
    expect(f.placed).toHaveLength(1);
    expect(st.notice).toBe(t("captions.newTrack"));
  });

  it("says in its own words when the captions could not be placed", async () => {
    const f = fakeCtx({
      placeInsert: async () => {
        throw new Error(t("premiere.placeFailed"));
      },
    });
    const st = await toReview(f);
    captionsAct(st, f.ctx, "captions-render", "");
    await tick();
    await tick();
    f.finish({
      kind: "captions-render",
      video: "/j/cap/captions-1.mov",
      srt: "/j/cap/captions-1.srt",
    });
    await tick();
    await tick();
    expect(st.error).toBe(t("captions.placeFailed"));
    expect(st.stage).toBe("review");
  });

  it("copies the SRT the app wrote to where the editor picks, and says nothing on cancel", async () => {
    const f = fakeCtx();
    const st = await toReview(f);
    st.stage = "placed";
    st.placed = {
      video: "/j/cap/captions-1.mov",
      srt: "/j/cap/captions-1.srt",
      atS: 0,
      durationS: 60,
      videoTrack: 2,
    };
    captionsAct(st, f.ctx, "captions-srt", "");
    await tick();
    await tick();
    // the file itself is copied: the panel never has to read the job folder
    expect(f.written).toEqual([["/j/cap/captions-1.srt", "Talk captions-1.srt"]]);
    expect(st.notice).toBe(
      t("captions.srtSaved", { path: "/Users/me/Desktop/Talk captions-1.srt" }),
    );

    const g = fakeCtx({ saveFileCopy: async () => null });
    const st2 = await toReview(g);
    st2.stage = "placed";
    st2.placed = st.placed;
    captionsAct(st2, g.ctx, "captions-srt", "");
    await tick();
    await tick();
    expect(st2.notice).toBeNull();
    expect(st2.error).toBeNull();
  });

  it("keeps a running caption job when another sequence opens, and forgets the old one's text otherwise", () => {
    const busy: CaptionsState = { ...newCaptions(), stage: "texting", jobId: "job-1" };
    captionsSwitch(busy, "seq-1", "seq-2", () => null);
    expect(busy.stage).toBe("texting");
    expect(busy.jobId).toBe("job-1");

    const done: CaptionsState = { ...newCaptions(), stage: "review", language: "tr" };
    const saved: Record<string, string> = {
      "captions:seq-2": JSON.stringify({
        glossary: ["Kilnframe"],
        mode: "spoken",
        look: "loud",
        colors: { text: "#ffffff", accent: "#00ff00" },
        overInserts: true,
      }),
      "captions-lang:seq-2": "en",
    };
    captionsSwitch(done, "seq-1", "seq-2", (k) => saved[k] ?? null);
    expect(done.stage).toBe("idle");
    expect(done.lines).toEqual([]);
    expect(done.language).toBe("en");
    expect(done.settings).toMatchObject({
      glossary: ["Kilnframe"],
      mode: "spoken",
      look: "loud",
      overInserts: true,
    });
    expect(done.settings.colors?.accent).toBe("#00ff00");
  });

  it("takes a colour the editor typed, and ignores one that is not a colour", () => {
    const shown = { text: "#ffffff", box: "rgba(10,12,16,0.62)" };
    const f = (text: string, box = shown.box) => ({
      text: { shown: shown.text, typed: text },
      box: { shown: shown.box, typed: box },
    });
    expect(typedColors(f("#ffffff"))).toBeNull();
    expect(typedColors(f("orange"))).toBeNull();
    // no accent field: the accent follows the text
    expect(typedColors(f(" #f4e9d8 "))).toEqual({
      text: "#f4e9d8",
      accent: "#f4e9d8",
      box: "rgba(10,12,16,0.62)",
    });
    expect(typedColors(f("#ffffff", "#1c2537"))).toEqual({
      text: "#ffffff",
      accent: "#ffffff",
      box: "#1c2537",
    });
  });

  it("keeps the settings per sequence", async () => {
    const f = fakeCtx();
    const st = await toReview(f);
    captionsAct(st, f.ctx, "captions-look", "editoryal");
    captionsAct(st, f.ctx, "captions-over", "");
    expect(JSON.parse(f.store["captions:seq-1"]!)).toMatchObject({
      look: "editoryal",
      overInserts: true,
      colors: { text: "#ffffff", accent: "#e8c58a" },
    });
  });

  it("looks for a new In/Out on the Captions tab's first step only", () => {
    expect(watchesSequence("captions", "idle", "idle")).toBe(true);
    expect(watchesSequence("captions", "idle", "review")).toBe(false);
    expect(watchesSequence("music", "idle", "review")).toBe(true);
  });
  it("keeps a finished text for its own sequence when another one was opened while it was made", async () => {
    const f = fakeCtx();
    const st = newCaptions();
    captionsAct(st, f.ctx, "captions-make", "");
    await tick();
    expect(st.stage).toBe("texting");
    captionsSwitch(st, "seq-1", "seq-2", () => null);
    f.finish(textResult);
    expect(st.stage).toBe("review");
    expect(st.seqId).toBe("seq-1");
    captionsSwitch(st, "seq-2", "seq-1", () => null);
    expect(st.lines).toHaveLength(2);
    captionsSwitch(st, "seq-1", "seq-2", () => null);
    expect(st.lines).toHaveLength(2);
    expect(st.seqId).toBe("seq-1");
  });

  it("does not start a text job while the app is not connected", async () => {
    const f = fakeCtx({ connected: () => false });
    const st = newCaptions();
    expect(captionsBox(st, f.ctx)).toMatch(/data-act="captions-make" disabled/);
    captionsAct(st, f.ctx, "captions-make", "");
    await tick();
    expect(st.stage).toBe("idle");
    expect(f.sent).toEqual([]);
  });

  it("escapes the companion's progress text", () => {
    const f = fakeCtx({ esc: (x) => x.replace(/</g, "&lt;") });
    const st: CaptionsState = { ...newCaptions(), stage: "texting", last: "<b>50%</b>" };
    expect(captionsBox(st, f.ctx)).toContain("&lt;b>50%");
  });

  it("says so when every line was emptied, instead of rendering nothing", async () => {
    const f = fakeCtx();
    const st = await toReview(f);
    st.drafts = ["", " "];
    captionsAct(st, f.ctx, "captions-render", "");
    await tick();
    expect(st.notice).toBe(t("captions.noLines"));
    expect(st.stage).toBe("review");
    expect(f.sent.some((p) => p.kind === "captions-render")).toBe(false);
  });

  it("replaces the placed clip after a new transcript of the same sequence", async () => {
    const f = fakeCtx();
    const st = await toReview(f);
    const placed = {
      video: "/j/cap/captions-1.mov",
      srt: "/j/cap/captions-1.srt",
      atS: 0,
      durationS: 60,
      videoTrack: 2,
    };
    Object.assign(st, { stage: "placed", placed });
    captionsAct(st, f.ctx, "captions-style", "");
    captionsAct(st, f.ctx, "captions-make", "");
    await tick();
    f.finish(textResult);
    expect(st.placed).toEqual(placed);
    captionsAct(st, f.ctx, "captions-render", "");
    await tick();
    f.finish({
      kind: "captions-render",
      video: "/j/cap/captions-2.mov",
      srt: "/j/cap/captions-2.srt",
    });
    await tick();
    expect(f.replaced).toEqual([
      [
        seq,
        { path: "/j/cap/captions-1.mov", atS: 0, durationS: 60 },
        "/j/cap/captions-2.mov",
        0,
        60,
        2,
      ],
    ]);
    expect(f.placed).toEqual([]);
  });

  it("looks the earlier clip up where it lay and places the new one at the new range", async () => {
    const range = {
      startS: 10,
      endS: 40,
      durationS: 30,
      source: "inout" as const,
      warning: null,
    };
    const looked: unknown[][] = [];
    const f = fakeCtx({
      inOut: () => range,
      findCaptionClip: async (...a) => {
        looked.push(a);
        return { videoTrack: 2 };
      },
    });
    const st = await toReview(f);
    Object.assign(st, {
      stage: "placed",
      placed: {
        video: "/j/cap/captions-1.mov",
        srt: "/j/cap/captions-1.srt",
        atS: 0,
        durationS: 60,
        videoTrack: 2,
      },
    });
    captionsAct(st, f.ctx, "captions-style", "");
    captionsAct(st, f.ctx, "captions-scope", "range");
    captionsAct(st, f.ctx, "captions-make", "");
    await tick();
    f.finish({ ...textResult, durationS: 30 });
    captionsAct(st, f.ctx, "captions-render", "");
    await tick();
    f.finish({
      kind: "captions-render",
      video: "/j/cap/captions-2.mov",
      srt: "/j/cap/captions-2.srt",
    });
    await tick();
    expect(looked).toEqual([[seq, "/j/cap/captions-1.mov", 0, 60]]);
    expect(f.replaced).toEqual([
      [
        seq,
        { path: "/j/cap/captions-1.mov", atS: 0, durationS: 60 },
        "/j/cap/captions-2.mov",
        10,
        30,
        2,
      ],
    ]);
    expect(st.placed).toMatchObject({ video: "/j/cap/captions-2.mov", atS: 10, durationS: 30 });
  });

  it("places on a new track and says so when the host could not take the earlier clip off", async () => {
    const f = fakeCtx({ replaceCaptionClip: async () => false });
    const st = await toReview(f);
    st.stage = "placed";
    st.placed = {
      video: "/j/cap/captions-1.mov",
      srt: "/j/cap/captions-1.srt",
      atS: 0,
      durationS: 60,
      videoTrack: 2,
    };
    captionsAct(st, f.ctx, "captions-render", "");
    await tick();
    await tick();
    f.finish({
      kind: "captions-render",
      video: "/j/cap/captions-2.mov",
      srt: "/j/cap/captions-2.srt",
    });
    await tick();
    await tick();
    expect(f.placed).toEqual([[seq, { video: "/j/cap/captions-2.mov", sfx: null }, 0, 0, 60]]);
    expect(st.notice).toBe(t("captions.newTrack"));
    expect(st.placed).toMatchObject({ video: "/j/cap/captions-2.mov", videoTrack: 2 });
  });

  it("writes the SRT in the sequence's time for an In/Out range", async () => {
    const range = {
      startS: 75.5,
      endS: 135.5,
      durationS: 60,
      source: "inout" as const,
      warning: null,
    };
    const f = fakeCtx({ inOut: () => range });
    const st = newCaptions();
    captionsAct(st, f.ctx, "captions-scope", "range");
    captionsAct(st, f.ctx, "captions-make", "");
    await tick();
    await tick();
    f.finish(textResult);
    captionsAct(st, f.ctx, "captions-render", "");
    await tick();
    await tick();
    expect(f.sent.find((p) => p.kind === "captions-render")).toMatchObject({ srtOffsetS: 75.5 });
  });

  it("says in one line when only some parts could be corrected", async () => {
    const f = fakeCtx();
    const st = await toReview(f, {
      ...textResult,
      corrected: true,
      correctionError: "1 of 3 parts kept the original text: 429",
    });
    const html = captionsBox(st, f.ctx);
    expect(html).toContain(t("captions.partlyCorrected"));
    expect(html).not.toContain(t("captions.notCorrected"));
    expect(t("captions.partlyCorrected")).not.toBe("captions.partlyCorrected");
    setLang("tr");
    expect(t("captions.partlyCorrected")).not.toMatch(/[—–]/);
  });

  describe("long sequences", () => {
    const bytes = (m: unknown) => new TextEncoder().encode(JSON.stringify(m)).length;

    it("sends a 90-minute talk's lines packed, well under a megabyte, and brings them back the same", async () => {
      const f = fakeCtx({ caret: () => 8 });
      const talk = longWords(90);
      const st = await toReview(f, { ...textResult, words: talk, durationS: 5400 });
      await flush();
      captionsAct(st, f.ctx, "captions-split", "0");
      st.drafts[5] = "Bambaşka bir cümle";
      captionsAct(st, f.ctx, "captions-merge", "7");
      await flush();
      const saves = f.requests.filter((m) => m.type === "captions.save");
      const save = saves[saves.length - 1]!;
      captionsAct(st, f.ctx, "captions-render", "");
      await flush();
      const render = f.requests.find(
        (m) => m.type === "job.start" && (m.params as { kind: string }).kind === "captions-render",
      )!;
      // what the same state and doc weighed with one object per word
      const before = bytes({ lines: st.lines, drafts: st.drafts, words: st.words });
      console.log(
        `90 min, ${talk.length} words: save ${bytes(save)} B, render ${bytes(render)} B, unpacked state ${before} B`,
      );
      expect(bytes(save)).toBeLessThan(600 * 1024);
      expect(bytes(render)).toBeLessThan(600 * 1024);
      // the words stay where the text job wrote them; the save does not carry them again
      expect(JSON.stringify(save)).not.toContain('"words"');
      f.disk["/j/cap"]!.words = talk;
      const back = newCaptions();
      captionsSwitch(back, undefined, "seq-1", f.ctx.stored);
      captionsBox(back, f.ctx);
      await flush();
      expect(back.lines).toEqual(msTimes(st.lines));
      expect(back.drafts).toEqual(st.drafts);
      expect(back.words).toEqual(talk);
    });

    it("says so instead of sending a message the app would refuse", async () => {
      expect(MAX_MESSAGE_BYTES).toBe(COMPANION_MAX);
      const f = fakeCtx();
      const st = await toReview(f);
      await flush();
      const sent = f.requests.length;
      const huge = "a".repeat(MAX_MESSAGE_BYTES);
      st.lines[0] = { ...st.lines[0]!, text: huge, words: [{ text: huge, start: 0.2, end: 1.6 }] };
      st.drafts[0] = huge;
      captionsAct(st, f.ctx, "captions-render", "");
      await flush();
      expect(f.requests.slice(sent).filter((m) => m.type !== "job.prepare")).toEqual([]);
      expect(f.sent.some((p) => p.kind === "captions-render")).toBe(false);
      expect(st.error).toBe(t("captions.tooLarge"));
      expect(st.stage).toBe("review");
      setLang("tr");
      expect(t("captions.tooLarge")).not.toMatch(/[—–]/);
      expect(t("captions.tooLarge")).not.toBe("captions.tooLarge");
    });

    it("keeps typed line edits 800 ms after the typing pauses", async () => {
      const f = fakeCtx();
      const st = await toReview(f);
      await flush();
      vi.useFakeTimers();
      try {
        const saves = () => f.requests.filter((m) => m.type === "captions.save").length;
        const before = saves();
        captionsLineInput(st, f.ctx, () => {
          st.drafts[1] = "Hadi başla";
        });
        await vi.advanceTimersByTimeAsync(500);
        captionsLineInput(st, f.ctx, () => {
          st.drafts[1] = "Hadi başlayalım!";
        });
        await vi.advanceTimersByTimeAsync(799);
        expect(saves()).toBe(before);
        await vi.advanceTimersByTimeAsync(1);
        expect(saves()).toBe(before + 1);
        expect((f.disk["/j/cap"]!.panel as { drafts: unknown }).drafts).toEqual({
          1: "Hadi başlayalım!",
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("asks for the preview folder again after the app reconnects (it empties it when it starts)", async () => {
      const f = fakeCtx();
      const st: CaptionsState = { ...newCaptions(), seqId: "seq-1" };
      captionsBox(st, f.ctx);
      await flush();
      f.finish({ kind: "captions-preview", images: {} });
      await flush();
      const asked = () => f.requests.filter((m) => m.type === "captions.previews").length;
      expect(asked()).toBe(1);
      captionsReconnected(st);
      captionsBox(st, f.ctx);
      await flush();
      expect(asked()).toBe(2);
    });
  });

  describe("the job folder", () => {
    it("makes a job folder only when the captions are prepared, never for the previews", async () => {
      const f = fakeCtx();
      const st: CaptionsState = { ...newCaptions(), seqId: "seq-1" };
      captionsBox(st, f.ctx);
      await flush();
      f.finish({ kind: "captions-preview", images: {} });
      await flush();
      expect(f.prepared).toEqual([]);
      expect(f.frameCalls).toHaveLength(1);
      captionsAct(st, f.ctx, "captions-make", "");
      await flush();
      expect(f.prepared).toEqual(["Talk Captions"]);
    });

    it("keeps the lines, edits, choices and placed clip in the job folder as they change", async () => {
      const f = fakeCtx({ caret: () => 8 });
      const st = await toReview(f);
      await flush();
      expect(f.store["captions-job:seq-1"]).toBe("/j/cap");
      const saved = () => f.disk["/j/cap"]!.panel as Record<string, unknown>;
      const savedLines = () => unpackLines(saved().lines as PackedLine[]);
      expect(saved()).toMatchObject({
        seqId: "seq-1",
        rangeStartS: 0,
        durationS: 60,
        language: "tr",
        placed: null,
      });
      expect(savedLines().map((l) => l.text)).toEqual([
        "Bugün Topview'i deneyeceğiz.",
        "Hadi başlayalım.",
      ]);
      captionsAct(st, f.ctx, "captions-split", "0");
      captionsAct(st, f.ctx, "captions-look", "loud");
      await flush();
      expect(savedLines().map((l) => l.text)).toEqual([
        "Bugün",
        "Topview'i deneyeceğiz.",
        "Hadi başlayalım.",
      ]);
      expect(saved()).toMatchObject({ edited: true, settings: { look: "loud" } });
      captionsAct(st, f.ctx, "captions-render", "");
      await flush();
      f.finish({
        kind: "captions-render",
        video: "/j/cap/captions-1.mov",
        srt: "/j/cap/captions-1.srt",
      });
      await flush();
      expect(saved().placed).toMatchObject({ video: "/j/cap/captions-1.mov", videoTrack: 2 });
    });

    it("comes back to the text and the placed clip when the tab opens on the sequence again", async () => {
      const f = fakeCtx({ caret: () => 8 });
      const before = await toReview(f);
      captionsAct(before, f.ctx, "captions-split", "0");
      before.drafts[2] = "Hadi başlayalım!";
      captionsAct(before, f.ctx, "captions-render", "");
      await flush();
      f.finish({
        kind: "captions-render",
        video: "/j/cap/captions-1.mov",
        srt: "/j/cap/captions-1.srt",
      });
      await flush();
      f.disk["/j/cap"]!.words = words;
      // the panel reloaded: a fresh tab opens on the same sequence
      const st = newCaptions();
      captionsSwitch(st, undefined, "seq-1", f.ctx.stored);
      captionsBox(st, f.ctx);
      await flush();
      expect(st.stage).toBe("placed");
      expect(st.jobDir).toBe("/j/cap");
      expect(st.lines.map((l) => l.text)).toEqual([
        "Bugün",
        "Topview'i deneyeceğiz.",
        "Hadi başlayalım.",
      ]);
      expect(st.drafts[2]).toBe("Hadi başlayalım!");
      expect(st.placed).toMatchObject({ video: "/j/cap/captions-1.mov", atS: 0, durationS: 60 });
      expect(st.words).toEqual(words);
      expect(captionsBox(st, f.ctx)).toContain(t("captions.rerender"));
      // another sequence's folder is not taken
      const other = newCaptions();
      captionsSwitch(other, undefined, "seq-2", (k) =>
        k === "captions-job:seq-2" ? "/j/cap" : null,
      );
      captionsBox(other, f.ctx);
      await flush();
      expect(other.lines).toEqual([]);
    });

    it("keeps the text when another sequence opens while the style is being changed", async () => {
      const f = fakeCtx();
      const st = await toReview(f);
      captionsAct(st, f.ctx, "captions-style", "");
      expect(st.stage).toBe("idle");
      captionsSwitch(st, "seq-1", "seq-2", () => null);
      expect(st.seqId).toBe("seq-1");
      expect(st.lines).toHaveLength(2);
      expect(captionsBox(st, f.ctx)).toContain(t("captions.backToText"));
    });
  });

  describe("previews", () => {
    const previews = (f: ReturnType<typeof fakeCtx>) =>
      f.sent.filter((p) => p.kind === "captions-preview") as Record<string, never>[];

    it("previews all nine looks once over a frame at a third of the range when step 1 opens", async () => {
      const f = fakeCtx();
      const st: CaptionsState = { ...newCaptions(), seqId: "seq-1" };
      captionsBox(st, f.ctx);
      captionsBox(st, f.ctx);
      await flush();
      captionsBox(st, f.ctx);
      await flush();
      const jobs = previews(f);
      expect(jobs).toHaveLength(1);
      // a third of the whole 60 s sequence
      expect(f.frames).toEqual([20]);
      const job = jobs[0] as unknown as {
        looks: string[];
        frame: string;
        colors?: unknown;
        atS: number;
        outDir: string;
        doc: { lines: { text: string; end: number }[]; width: number; height: number; fps: string };
      };
      expect(job.looks).toEqual([
        "bant",
        "loud",
        "dinamik",
        "hap",
        "karaoke",
        "daktilo",
        "sakin",
        "kil-lacivert",
        "editoryal",
      ]);
      // previews live in the app's own folder, not in the editor's project
      expect(job.frame).toBe("/kf/previews/frame-1.png");
      expect(job.outDir).toBeUndefined();
      expect(job.colors).toBeUndefined();
      // no transcript yet: the sample text in the speech's language
      expect(job.doc.lines[0]!.text).toBe("Let's make this together today.");
      // quarter size, even numbers
      expect(job.doc).toMatchObject({ width: 270, height: 480, fps: "25" });
      expect(job.atS).toBeLessThan(job.doc.lines[0]!.end);
      // until the stills come the tiles are drawings; then each tile shows its still
      expect(captionsBox(st, f.ctx)).not.toContain("<slot");
      f.finish({
        kind: "captions-preview",
        stills: {},
        images: {
          bant: "data:image/jpeg;base64,QkFOVA==",
          loud: "data:image/jpeg;base64,TE9VRA==",
        },
      });
      await flush();
      const html = captionsBox(st, f.ctx);
      expect(html).toContain('<slot key="cap:bant" src="data:image/jpeg;base64,QkFOVA=="');
      expect(html).toContain('<slot key="cap:loud"');
      // a look without a still keeps its drawing
      expect(html).toMatch(/data-val="hap"><div class="tile-img cap-frame"/);
      expect(previews(f)).toHaveLength(1);
    });

    it("uses the Turkish sample text, or the transcript's first line once there is one", async () => {
      setLang("tr");
      const f = fakeCtx();
      const st: CaptionsState = { ...newCaptions(), seqId: "seq-1" };
      captionsBox(st, f.ctx);
      await flush();
      expect(
        (previews(f)[0] as unknown as { doc: { lines: { text: string }[] } }).doc.lines[0]!.text,
      ).toBe("Bugün bunu birlikte yapacağız.");
      const g = fakeCtx();
      const rv = await toReview(g);
      captionsAct(rv, g.ctx, "captions-style", "");
      captionsBox(rv, g.ctx);
      await flush();
      const doc = (
        previews(g)[0] as unknown as {
          doc: { lines: { text: string; start: number }[]; language: string };
        }
      ).doc;
      expect(doc.lines[0]!.text).toBe("Bugün Topview'i deneyeceğiz.");
      expect(doc.language).toBe("tr");
    });

    it("starts no preview while the app is not connected", async () => {
      const f = fakeCtx({ connected: () => false });
      captionsBox({ ...newCaptions(), seqId: "seq-1" }, f.ctx);
      await flush();
      expect(previews(f)).toEqual([]);
    });

    it("previews the selected look alone in the typed colours, 400 ms after the last change", async () => {
      vi.useFakeTimers();
      try {
        const f = fakeCtx();
        const st: CaptionsState = { ...newCaptions(), seqId: "seq-1" };
        captionsBox(st, f.ctx);
        await flush();
        f.finish({ kind: "captions-preview", stills: {}, images: {} });
        await flush();
        const typed = { text: "#ff0000", accent: "#ff0000", box: "rgba(10,12,16,0.62)" };
        captionsColorInput(st, f.ctx, () => ({ ...typed, text: "#ee0000" }));
        await vi.advanceTimersByTimeAsync(200);
        captionsColorInput(st, f.ctx, () => typed);
        await vi.advanceTimersByTimeAsync(399);
        expect(previews(f)).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        await flush();
        const jobs = previews(f);
        expect(jobs).toHaveLength(2);
        expect(jobs[1]).toMatchObject({ looks: ["bant"], colors: typed });
        expect(st.settings.colors).toEqual(typed);
        f.finish({
          kind: "captions-preview",
          stills: {},
          images: { bant: "data:image/jpeg;base64,UkVE" },
        });
        await flush();
        expect(captionsBox(st, f.ctx)).toContain(
          '<slot key="cap:bant" src="data:image/jpeg;base64,UkVE"',
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("plays a 2.5 s window around a line at quarter size, as six stills where the panel has no video", async () => {
      const f = fakeCtx();
      const st = await toReview(f);
      captionsAct(st, f.ctx, "captions-play", "1");
      await flush();
      const job = f.sent.find((p) => p.kind === "captions-render") as unknown as {
        doc: {
          lines: { text: string; start: number; end: number }[];
          durationS: number;
          width: number;
          height: number;
        };
        look: string;
        outDir: string;
        preview: { frame: string; stills: number; video: boolean };
      };
      expect(job).toBeDefined();
      // "Hadi başlayalım." runs 3.0 to 3.9 s: the window is 2.2 to 4.7 s
      expect(job.doc.durationS).toBeCloseTo(2.5);
      expect(job.doc.lines.map((l) => l.text)).toEqual(["Hadi başlayalım."]);
      expect(job.doc.lines[0]!.start).toBeCloseTo(0.8);
      expect(job.doc).toMatchObject({ width: 270, height: 480 });
      expect(job.preview).toEqual({ frame: "/kf/previews/frame-1.png", stills: 6, video: false });
      expect(f.frames[0]).toBeCloseTo(3.45);
      // the tab stays usable meanwhile
      expect(st.stage).toBe("review");
      expect(captionsBox(st, f.ctx)).toContain(t("captions.playing"));
      const frames = [1, 2, 3, 4, 5, 6].map((n) => `data:image/jpeg;base64,${n}`);
      f.finish({ kind: "captions-render", video: "/j/v.mov", srt: "/j/v.srt", frames, clip: null });
      await flush();
      const html = captionsBox(st, f.ctx);
      expect(html).toContain('<slot key="cap-play" src="data:image/jpeg;base64,1"');
      expect(html).not.toContain("<video");
      // nothing was placed: a preview is not the captions
      expect(f.placed).toEqual([]);
    });

    it("plays the small clip where the panel can play video", async () => {
      const f = fakeCtx({ playsVideo: () => true });
      const st = await toReview(f);
      captionsAct(st, f.ctx, "captions-play", "0");
      await flush();
      const job = f.sent.find((p) => p.kind === "captions-render") as unknown as {
        doc: { durationS: number; lines: { start: number }[] };
        preview: { video: boolean };
      };
      expect(job.preview.video).toBe(true);
      // the first line starts the sequence: the window cannot start before 0
      expect(job.doc.lines[0]!.start).toBeCloseTo(0.2);
      expect(job.doc.durationS).toBeCloseTo(2.5);
      f.finish({
        kind: "captions-render",
        video: "/j/v.mov",
        srt: "/j/v.srt",
        frames: ["data:image/jpeg;base64,1"],
        clip: "data:video/mp4;base64,AAAA",
      });
      await flush();
      expect(captionsBox(st, f.ctx)).toMatch(/<video[^>]+src="data:video\/mp4;base64,AAAA"/);
    });

    it("runs one play at a time: a repeat waits for nothing, the latest other request runs next", async () => {
      const f = fakeCtx();
      const st = await toReview(f);
      const plays = () =>
        f.sent.filter((p) => p.kind === "captions-render") as unknown as {
          doc: { lines: { text: string }[] };
        }[];
      captionsAct(st, f.ctx, "captions-play", "0");
      await flush();
      captionsAct(st, f.ctx, "captions-play", "0");
      captionsAct(st, f.ctx, "captions-play", "1");
      captionsAct(st, f.ctx, "captions-play", "0");
      captionsAct(st, f.ctx, "captions-play", "1");
      await flush();
      expect(plays()).toHaveLength(1);
      f.finish({
        kind: "captions-render",
        video: "/j/v.mov",
        srt: "/j/v.srt",
        frames: ["data:image/jpeg;base64,1"],
        clip: null,
      });
      await flush();
      expect(plays()).toHaveLength(2);
      expect(plays()[1]!.doc.lines[0]!.text).toBe("Hadi başlayalım.");
      // the same line again with nothing changed: shown again without a render
      f.finish({
        kind: "captions-render",
        video: "/j/v.mov",
        srt: "/j/v.srt",
        frames: ["data:image/jpeg;base64,2"],
        clip: null,
      });
      await flush();
      captionsAct(st, f.ctx, "captions-play", "1");
      await flush();
      expect(plays()).toHaveLength(2);
    });

    it("takes the tiles' frame at quarter size with Kilnframe's inserts off, and reuses it for the colours", async () => {
      const f = fakeCtx();
      const st: CaptionsState = { ...newCaptions(), seqId: "seq-1" };
      captionsBox(st, f.ctx);
      await flush();
      expect(f.frameCalls).toEqual([
        { seconds: 20, name: "caption-frame.png", width: 270, height: 480, hidden: true },
      ]);
      expect(f.hidden).toEqual([{ startS: 19.5, endS: 20.5 }]);
      f.finish({ kind: "captions-preview", images: { bant: "data:image/jpeg;base64,QQ==" } });
      await flush();
      st.settings.colors = { text: "#ff0000", accent: "#ff0000", box: "rgba(10,12,16,0.62)" };
      captionsBox(st, f.ctx);
      await flush();
      const tint = previews(f)[1] as unknown as { frame: string; looks: string[] };
      expect(tint.looks).toEqual(["bant"]);
      expect(tint.frame).toBe("/kf/previews/frame-1.png");
      expect(f.frameCalls).toHaveLength(1);
    });

    it("stops a running preview before the editor's own text job is sent", async () => {
      const f = fakeCtx();
      const st: CaptionsState = { ...newCaptions(), seqId: "seq-1" };
      captionsBox(st, f.ctx);
      await flush();
      expect(previews(f)).toHaveLength(1);
      captionsAct(st, f.ctx, "captions-make", "");
      await flush();
      const cancel = f.sent.findIndex((m) => m.type === "job.cancel" && m.jobId === "job-1");
      const text = f.sent.findIndex((m) => m.kind === "captions-text");
      expect(cancel).toBeGreaterThanOrEqual(0);
      expect(text).toBeGreaterThan(cancel);
      f.cancelled(1);
      await flush();
      // nothing new is asked for while the text is made
      captionsBox(st, f.ctx);
      await flush();
      expect(previews(f)).toHaveLength(1);
      expect(st.error).toBeNull();
    });

    it("stops the captions' Play preview before rendering the captions", async () => {
      const f = fakeCtx();
      const st = await toReview(f);
      captionsAct(st, f.ctx, "captions-play", "0");
      await flush();
      captionsAct(st, f.ctx, "captions-render", "");
      await flush();
      expect(f.sent.some((m) => m.type === "job.cancel" && m.jobId === "job-2")).toBe(true);
      f.cancelled(2);
      await flush();
      // a stopped preview is not a failure
      expect(st.notice).toBeNull();
    });

    it("stops a running tiles preview when a newer one takes its place", async () => {
      let style: string | null = null;
      const f = fakeCtx({ videoStyle: () => style });
      const st: CaptionsState = { ...newCaptions(), seqId: "seq-1" };
      captionsBox(st, f.ctx);
      await flush();
      style = "kil-lacivert";
      captionsBox(st, f.ctx);
      await flush();
      expect(f.sent.some((m) => m.type === "job.cancel" && m.jobId === "job-1")).toBe(true);
      f.cancelled(1);
      await flush();
      const jobs = previews(f) as unknown as { looks: string[] }[];
      expect(jobs).toHaveLength(2);
      expect(jobs[1]!.looks[0]).toBe("kil-lacivert");
    });

    it("keeps the looks that came when one could not be drawn, and asks again a little later after a failure", async () => {
      vi.useFakeTimers();
      try {
        const f = fakeCtx();
        const st: CaptionsState = { ...newCaptions(), seqId: "seq-1" };
        captionsBox(st, f.ctx);
        await flush();
        f.finish({
          kind: "captions-preview",
          images: { bant: "data:image/jpeg;base64,QQ==", loud: null },
        });
        await flush();
        expect(Object.keys(st.tiles)).toEqual(["bant"]);

        const g = fakeCtx();
        const failed: CaptionsState = { ...newCaptions(), seqId: "seq-1" };
        captionsBox(failed, g.ctx);
        await flush();
        g.fail("HyperFrames could not start");
        await flush();
        captionsBox(failed, g.ctx);
        await flush();
        expect(previews(g)).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(10_000);
        captionsBox(failed, g.ctx);
        await flush();
        expect(previews(g)).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not send a failed colour preview again on every render", async () => {
      const f = fakeCtx();
      const st: CaptionsState = { ...newCaptions(), seqId: "seq-1" };
      captionsBox(st, f.ctx);
      await flush();
      f.finish({ kind: "captions-preview", images: { bant: "data:image/jpeg;base64,QQ==" } });
      await flush();
      st.settings.colors = { text: "#ff0000", accent: "#ff0000", box: "rgba(10,12,16,0.62)" };
      captionsBox(st, f.ctx);
      await flush();
      expect(previews(f)).toHaveLength(2);
      f.fail("no still");
      await flush();
      captionsBox(st, f.ctx);
      captionsBox(st, f.ctx);
      await flush();
      expect(previews(f)).toHaveLength(2);
    });

    it("looks into each still where its look sets the captions", () => {
      // landscape: the bottom of the captions (the safe area's edge, 1/9 up) near the bottom of the window
      const land = stillWindow(110, 9 / 16);
      const bottom = land.fullH * (1 - 120 / 1080);
      expect(land.top + land.boxH).toBeGreaterThan(bottom);
      expect(land.top + land.boxH - bottom).toBeLessThan(land.boxH * 0.2);
      // portrait: the window centred on the captions' line, 68.5 % down
      const port = stillWindow(110, 16 / 9);
      expect(port.top + port.boxH / 2).toBeCloseTo(port.fullH * 0.685, 0);
      // square: above the square safe area's bottom edge
      const sq = stillWindow(110, 1);
      expect(sq.top + sq.boxH).toBeGreaterThan(sq.fullH * (1 - 140 / 1080));
      for (const w of [land, port, sq]) {
        expect(w.top).toBeGreaterThanOrEqual(0);
        expect(w.top + w.boxH).toBeLessThanOrEqual(w.fullH);
      }
    });
  });
});
