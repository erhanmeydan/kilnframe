import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captionsAct,
  captionsBox,
  captionsColorInput,
  captionsSwitch,
  caretWord,
  newCaptions,
  typedColors,
  type CaptionsCtx,
  type CaptionsState,
} from "../src/captions";
import { setLang, t } from "../src/i18n";
import en from "../src/locales/en.json";
import tr from "../src/locales/tr.json";
import { watchesSequence } from "../src/music";

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
  const listeners = new Set<Listener>();
  const frames: number[] = [];
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
      if (msg.type === "job.prepare") return { type: "job.prepared", jobDir: "/j/cap" };
      if (msg.type === "job.start") {
        sent.push(msg.params as Record<string, unknown>);
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
    withoutOurInserts: async (_s, _r, fn) => fn(),
    exportAudio: async () => ({ ok: true, offsetSeconds: 0 }),
    ourInsertSpans: async () => [{ startS: 10, endS: 14 }],
    placeInsert: async (...a) => {
      placed.push(a);
      return { videoTrack: 2, audioTrack: 2 };
    },
    findCaptionClip: async () => ({ videoTrack: 2 }),
    replaceCaptionClip: async (...a) => {
      replaced.push(a);
    },
    caret: () => null,
    exportFrame: async (_s, seconds, dir) => {
      frames.push(seconds);
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
    readTextFile: async () => "1\n00:00:00,200 --> 00:00:01,600\nBugün\n",
    writeTextFile: async (p, text) => {
      written.push([p, text]);
    },
    ...over,
  };
  const emit = (m: Record<string, unknown>) => [...listeners].forEach((fn) => fn(m));
  const finish = (result: Record<string, unknown>, job = jobs) =>
    emit({ type: "job.done", jobId: `job-${job}`, result });
  const fail = (message: string) => emit({ type: "job.error", jobId: `job-${jobs}`, message });
  return { ctx, sent, placed, replaced, written, store, frames, finish, fail };
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
    expect(f.replaced).toEqual([[seq, "/j/cap/captions-1.mov", "/j/cap/captions-2.mov", 0, 60, 2]]);
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

  it("saves the SRT where the editor picks, or next to the project when the editor has no save dialog", async () => {
    const saved: string[] = [];
    const f = fakeCtx({
      saveTextFile: async (name, text) => {
        saved.push(name, text);
        return "/Users/me/Desktop/Talk.srt";
      },
    });
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
    expect(saved[0]).toBe("Talk.srt");
    expect(saved[1]).toContain("Bugün");
    expect(st.notice).toBe(t("captions.srtSaved", { path: "/Users/me/Desktop/Talk.srt" }));

    const g = fakeCtx();
    const st2 = await toReview(g);
    st2.stage = "placed";
    st2.placed = {
      video: "/j/cap/captions-1.mov",
      srt: "/j/cap/captions-1.srt",
      atS: 0,
      durationS: 60,
      videoTrack: 2,
    };
    captionsAct(st2, g.ctx, "captions-srt", "");
    await tick();
    await tick();
    expect(g.written[0]![0]).toBe("/p/Talk captions-1.srt");
    expect(st2.notice).toBe(t("captions.srtSaved", { path: "/p/Talk captions-1.srt" }));
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
    expect(f.replaced).toEqual([[seq, "/j/cap/captions-1.mov", "/j/cap/captions-2.mov", 0, 60, 2]]);
    expect(f.placed).toEqual([]);
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
      expect(job.frame).toBe("/j/cap/frame-1.png");
      expect(job.outDir).toBe("/j/cap/preview");
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
      expect(job.outDir).toBe("/j/cap/preview");
      expect(job.preview).toEqual({ frame: "/j/cap/frame-1.png", stills: 6, video: false });
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
  });
});
