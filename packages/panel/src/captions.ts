// The Captions tab: the whole sequence or the In/Out range captioned in one of nine looks. Step one picks the
// look, its colours and the spelling, and asks the companion for the words (captions-text: Whisper, then the
// editor's text model corrects them). Step two shows the lines to read and fix as text only. Step three renders
// them as one transparent clip (captions-render), places it over the speech and saves the SRT on request.
import { mergeLines, retimeLine, splitLineAt, splitLines } from "../../core/src/captions/lines";
import { CAPTION_LOOKS, captionGrid, type CaptionLook } from "../../core/src/captions/styles";
import type {
  CaptionColors,
  CaptionLine,
  CaptionStyleId,
  CaptionWord,
} from "../../core/src/captions/types";
import type { ServerMessage } from "./companion-session";
import { shapeOf } from "./format-check";
import type { HostSequence, PlaceResult } from "./host";
import { lang, t } from "./i18n";
import { clock } from "./music";
import type { Range } from "./range";

export type { CaptionColors, CaptionLine, CaptionStyleId };

/** What the editor chose for a sequence; kept per sequence, as the range tab keeps its style. */
export interface CaptionsSettings {
  glossary: string[];
  /** Turkish only: spelled by the rules, or as it was said. */
  mode: "written" | "spoken";
  /** Null: the grid's first look, the one that follows the video's style. */
  look: CaptionStyleId | null;
  /** Null: the look's own colours. */
  colors: CaptionColors | null;
  /** Captions also over Kilnframe's animation inserts (hidden there by default). */
  overInserts: boolean;
}

/** The clip on the timeline, found again by its path, start and length for a re-render. */
export interface PlacedCaptions {
  video: string;
  srt: string;
  atS: number;
  durationS: number;
  videoTrack: number;
}

export interface CaptionsState {
  scope: "all" | "range";
  stage: "idle" | "texting" | "review" | "rendering" | "placing" | "placed";
  settings: CaptionsSettings;
  /** The glossary as typed: commas and all. */
  glossaryText: string;
  /** Language of this sequence's last transcript; null before there is one. */
  language: string | null;
  last: string;
  jobId: string | null;
  jobDir: string | null;
  /** The sequence the text belongs to: placed there only. */
  seqId: string | null;
  projectPath: string;
  seqName: string;
  /** Where the range starts in the sequence: the clip is placed here, line times count from here. */
  rangeStartS: number;
  durationS: number;
  /** The sequence's shape: each look wraps narrower in portrait. */
  format: "portrait" | "landscape" | "square";
  /** The corrected words, split again when another look wraps narrower or wider. */
  words: CaptionWord[];
  /** Whisper's own words, when the correction changed them: lines that differ are marked. */
  original: CaptionWord[];
  lines: CaptionLine[];
  /** What the editor typed in each line's field, in the order of `lines`. */
  drafts: string[];
  /** The editor split, joined or retyped a line: another look keeps the lines as they are. */
  edited: boolean;
  correctionError: string | null;
  placed: PlacedCaptions | null;
  /** A calm one-line note (no speech, a new track, where the SRT went). */
  notice: string | null;
  error: string | null;
}

function newSettings(): CaptionsSettings {
  return { glossary: [], mode: "written", look: null, colors: null, overInserts: false };
}

export function newCaptions(): CaptionsState {
  return {
    scope: "all",
    stage: "idle",
    settings: newSettings(),
    glossaryText: "",
    language: null,
    last: "",
    jobId: null,
    jobDir: null,
    seqId: null,
    projectPath: "",
    seqName: "",
    rangeStartS: 0,
    durationS: 0,
    format: "landscape",
    words: [],
    original: [],
    lines: [],
    drafts: [],
    edited: false,
    correctionError: null,
    placed: null,
    notice: null,
    error: null,
  };
}

/** What the tab needs from the rest of the panel. */
export interface CaptionsCtx {
  esc(s: string): string;
  reportLink(error: string): string;
  seg<T extends string>(name: string, value: T, options: [T, string][]): string;
  render(): void;
  trace(line: string): void;
  connected(): boolean;
  inOut(): Range | null;
  /** The range line above the choices, as on the Music tab. */
  rangeLine(scope: "all" | "range"): string;
  /** The range tab's style for this sequence: Kil Lacivert puts its own captions first. */
  videoStyle(): string | null;
  tileWidth(): number;
  readSequence(): Promise<HostSequence | null>;
  request(message: unknown, reply: string, timeoutMs?: number): Promise<ServerMessage>;
  send(message: unknown): void;
  on(listener: (m: ServerMessage) => void): () => void;
  providerParams(): Record<string, string>;
  withoutOurInserts<T>(target: HostSequence, range: Range, fn: () => Promise<T>): Promise<T>;
  exportAudio(
    target: HostSequence,
    range: Range,
    file: string,
  ): Promise<{ ok: boolean; offsetSeconds: number }>;
  ourInsertSpans(target: HostSequence): Promise<{ startS: number; endS: number }[]>;
  placeInsert(
    target: HostSequence,
    files: { video: string; sfx: string | null },
    atS: number,
    handlesS: number,
    durationS: number,
  ): Promise<PlaceResult>;
  findCaptionClip(
    target: HostSequence,
    mediaPath: string,
    atS: number,
    durationS: number,
  ): Promise<{ videoTrack: number } | null>;
  replaceCaptionClip(
    target: HostSequence,
    oldPath: string,
    file: string,
    atS: number,
    durationS: number,
    videoTrack: number,
  ): Promise<void>;
  /** Where the caret stands in a field, when the editor can say. */
  caret(id: string): number | null;
  stored(key: string): string | null;
  store(key: string, value: string): void;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, text: string): Promise<void>;
  /** The editor's own save dialog; the saved path, or null when the editor cancelled. */
  saveTextFile?(suggestedName: string, text: string): Promise<string | null>;
}

const settingsKey = (seqId: string) => `captions:${seqId}`;
const languageKey = (seqId: string) => `captions-lang:${seqId}`;

/** The look in use: the editor's, else the grid's first. */
export function lookOf(st: CaptionsState, videoStyle: string | null): CaptionLook {
  return CAPTION_LOOKS[st.settings.look ?? captionGrid(videoStyle)[0]!];
}

function colorsOf(st: CaptionsState, look: CaptionLook): CaptionColors {
  return st.settings.colors ?? { ...look.colors };
}

function saveSettings(st: CaptionsState, ctx: CaptionsCtx): void {
  if (st.seqId) ctx.store(settingsKey(st.seqId), JSON.stringify(st.settings));
}

function readSettings(raw: string | null): CaptionsSettings {
  if (!raw) return newSettings();
  try {
    const s = JSON.parse(raw) as Partial<CaptionsSettings>;
    return {
      glossary: Array.isArray(s.glossary) ? s.glossary.map(String) : [],
      mode: s.mode === "spoken" ? "spoken" : "written",
      look: s.look && s.look in CAPTION_LOOKS ? s.look : null,
      colors: s.colors && s.colors.text && s.colors.accent ? s.colors : null,
      overInserts: s.overInserts === true,
    };
  } catch {
    return newSettings();
  }
}

/**
 * The panel read the sequence: another one is open. Its text and clip belong to the last sequence, so they are
 * forgotten and the new one's settings come in, unless a caption job is running (it finishes for its own).
 */
export function captionsSwitch(
  st: CaptionsState,
  previous: string | undefined,
  next: string,
  stored: (key: string) => string | null,
): void {
  if (st.stage === "texting" || st.stage === "rendering" || st.stage === "placing") return;
  if (previous === next && st.seqId === next) return;
  const settings = readSettings(stored(settingsKey(next)));
  Object.assign(st, newCaptions(), {
    scope: st.scope,
    seqId: next,
    settings,
    glossaryText: settings.glossary.join(", "),
    language: stored(languageKey(next)),
  });
}

/** The word a split starts the second part at: the one the caret is in, else the next, else the middle. */
export function caretWord(text: string, caret: number | null): number {
  const count = text.split(/\s+/).filter(Boolean).length;
  const middle = Math.max(1, Math.floor(count / 2));
  if (caret === null || caret <= 0 || caret >= text.trimEnd().length) return middle;
  const before = text.slice(0, caret).split(/\s+/).filter(Boolean).length;
  const inWord = /\S$/.test(text.slice(0, caret)) && /^\S/.test(text.slice(caret));
  return Math.min(count - 1, Math.max(1, inWord ? before - 1 : before));
}

function glossaryOf(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 200)
    .map((s) => s.slice(0, 100));
}

const COLOR_KEYS = ["text", "accent", "box"] as const;
type ColorFields = Partial<Record<(typeof COLOR_KEYS)[number], { shown: string; typed: string }>>;

/**
 * The colours after the editor typed in the colour fields, or null when nothing valid changed. A look whose
 * accent is its text colour shows no accent field: the accent follows the text.
 */
export function typedColors(fields: ColorFields): CaptionColors | null {
  const value = (k: (typeof COLOR_KEYS)[number]) => {
    const f = fields[k];
    if (!f) return null;
    const typed = f.typed.trim();
    return typed !== f.shown && COLOR.test(typed) ? typed : f.shown;
  };
  const changed = COLOR_KEYS.some((k) => fields[k] && value(k) !== fields[k]!.shown);
  if (!changed || !fields.text) return null;
  const text = value("text")!;
  const box = value("box");
  return { text, accent: value("accent") ?? text, ...(box ? { box } : {}) };
}

const COLOR = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|#[0-9a-f]{8}|rgba?\([\d\s.,%]+\))$/i;

function fieldValue(id: string): string | null {
  const el = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
  return el ? (el.value ?? "") : null;
}

/** Keeps what the editor typed across renders (UXP reports a field's value only once it was set). */
export function captionsReadFields(st: CaptionsState): void {
  const glossary = fieldValue("cap-glossary");
  if (glossary !== null) {
    st.glossaryText = glossary;
    st.settings.glossary = glossaryOf(glossary);
  }
  const fields: ColorFields = {};
  for (const key of COLOR_KEYS) {
    const el = document.getElementById(`cap-color-${key}`) as HTMLInputElement | null;
    if (el) fields[key] = { shown: el.getAttribute("value") ?? "", typed: el.value ?? "" };
  }
  const colors = typedColors(fields);
  if (colors) st.settings.colors = colors;
  st.drafts = st.drafts.map((d, i) => fieldValue(`cap-line-${i}`) ?? d);
}

export function captionsWriteFields(st: CaptionsState): void {
  const set = (id: string, v: string) => {
    const el = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
    if (el) el.value = v;
  };
  set("cap-glossary", st.glossaryText);
  for (const key of COLOR_KEYS) {
    const el = document.getElementById(`cap-color-${key}`) as HTMLInputElement | null;
    if (el) el.value = el.getAttribute("value") ?? "";
  }
  st.drafts.forEach((d, i) => set(`cap-line-${i}`, d));
}

// ---------- screens ----------

const SAMPLE = { en: ["Make it", "together"], tr: ["Birlikte", "yapalım"] };

/** A small drawing of the look: two words in its colours, its box or pill, its case. Real stills come later. */
function lookTile(look: CaptionLook, sel: boolean, width: number, colors: CaptionColors): string {
  const height = Math.round((width * 9) / 16);
  const [a, b] = SAMPLE[lang() === "tr" ? "tr" : "en"];
  const up = (s: string) => (look.uppercase ? s.toLocaleUpperCase(lang()) : s);
  const box = colors.box && colors.box !== colors.accent ? colors.box : null;
  const pill = colors.box && colors.box === colors.accent;
  const second = pill
    ? `<span class="cw pill" style="background:${colors.accent};color:${colors.text}">${up(b)}</span>`
    : `<span class="cw" style="color:${colors.accent}">${up(b)}</span>`;
  const font = `font-weight:${look.weight >= 600 ? 700 : 400}`;
  const family = /anton/.test(look.font)
    ? ` cap-condensed`
    : /mono/i.test(look.font)
      ? ` cap-mono`
      : /playfair/.test(look.font)
        ? ` cap-serif`
        : "";
  return `<div class="tile${sel ? " sel" : ""}" style="width:${width}px" data-act="captions-look" data-val="${look.id}"><div class="tile-img cap-frame" style="width:${width - 4}px;height:${height - 4}px"><div class="cap-sample${family}" style="${font};${box ? `background:${box};` : ""}"><span class="cw" style="color:${colors.text}">${up(a)}</span> ${second}</div></div><div class="tile-name">${sel ? "✓ " : ""}${look.name[lang()]}</div></div>`;
}

function colorRow(st: CaptionsState, ctx: CaptionsCtx, look: CaptionLook): string {
  const colors = colorsOf(st, look);
  const keys: ("text" | "accent" | "box")[] = ["text"];
  if (look.colors.accent !== look.colors.text) keys.push("accent");
  if (look.colors.box) keys.push("box");
  const own = JSON.stringify(colors) !== JSON.stringify(look.colors);
  return `<div class="swatches">${keys
    .map(
      (k) =>
        `<div class="swatch"><div class="chip" style="background:${ctx.esc(colors[k] ?? "")}"></div><div class="swatch-text"><div class="small muted">${t(`captions.color.${k}`)}</div><input class="img-note" id="cap-color-${k}" type="text" value="${ctx.esc(colors[k] ?? "")}"></div></div>`,
    )
    .join(
      "",
    )}</div>${own ? `<div class="link" data-act="captions-colors-reset">${t("captions.colorsReset")}</div>` : ""}`;
}

/** Whether to offer the Turkish spelling choice: the last transcript was Turkish, or a Turkish panel before one. */
function turkishSpeech(st: CaptionsState): boolean {
  return st.language === null ? lang() === "tr" : st.language === "tr";
}

function stepOne(st: CaptionsState, ctx: CaptionsCtx): string {
  const range = ctx.inOut();
  const scopes: ["all" | "range", string][] = [["all", t("captions.scopeAll")]];
  if (range) scopes.push(["range", t("captions.scopeRange")]);
  const look = lookOf(st, ctx.videoStyle());
  const width = ctx.tileWidth();
  const tiles = captionGrid(ctx.videoStyle())
    .map((id) => {
      const l = CAPTION_LOOKS[id];
      return lookTile(l, id === look.id, width, id === look.id ? colorsOf(st, l) : l.colors);
    })
    .join("");
  const hasText = st.lines.length > 0;
  return `${ctx.rangeLine(range ? st.scope : "all")}
  <div class="lbl">${t("captions.scope")}</div>
  ${ctx.seg("captions-scope", range ? st.scope : "all", scopes)}
  <div class="lbl">${t("captions.look")}</div>
  <div class="tiles">${tiles}</div>
  <div class="lbl">${t("captions.colors")}</div>
  ${colorRow(st, ctx, look)}
  <div class="lbl">${t("captions.glossary")}</div>
  <input class="img-note" id="cap-glossary" type="text" placeholder="${t("captions.glossaryPlaceholder")}">
  ${
    turkishSpeech(st)
      ? `<div class="lbl">${t("captions.mode")}</div>${ctx.seg("captions-mode", st.settings.mode, [
          ["written", t("captions.modeWritten")],
          ["spoken", t("captions.modeSpoken")],
        ])}`
      : ""
  }
  <div class="check mt" data-act="captions-over"><span class="box-mark${st.settings.overInserts ? " on" : ""}">${st.settings.overInserts ? "✓" : ""}</span><span>${t("captions.overInserts")}</span></div>
  ${
    hasText
      ? `<div class="btn mt" data-act="captions-back">${t("captions.backToText")}</div>
  <div class="link mt" data-act="captions-make">${t("captions.newTranscript")}</div>`
      : `<div class="btn mt${ctx.connected() ? "" : " off"}" data-act="captions-make">${t("captions.make")}</div>`
  }`;
}

function lineRows(st: CaptionsState): string {
  return st.lines
    .map((line, i) => {
      const words = (st.drafts[i] ?? line.text).split(/\s+/).filter(Boolean).length;
      const links = [
        words > 1
          ? `<div class="link" data-act="captions-split" data-val="${i}">${t("captions.split")}</div>`
          : "",
        i < st.lines.length - 1
          ? `<div class="link" data-act="captions-merge" data-val="${i}">${t("captions.merge")}</div>`
          : "",
      ].join("");
      return `<div class="cline${line.changed ? " changed" : ""}"><div class="row small muted"><span>${clock(st.rangeStartS + line.start)}</span>${
        line.changed ? `<span class="ctag">${t("captions.changed")}</span>` : ""
      }</div><textarea class="cline-text" id="cap-line-${i}"></textarea>${links ? `<div class="row2">${links}</div>` : ""}</div>`;
    })
    .join("");
}

function reviewScreen(st: CaptionsState): string {
  const placed = st.stage === "placed" && st.placed;
  const fixed = st.correctionError
    ? `<div class="small warn-text">${t("captions.notCorrected")}</div>`
    : `<div class="small muted">${t("captions.checkHelp")}</div>`;
  return `<div class="lbl">${t("captions.check")}</div>${fixed}
  <div class="clines">${lineRows(st)}</div>
  <div class="btn mt" data-act="captions-render">${t(placed ? "captions.rerender" : "captions.render")}</div>
  ${placed ? `<div class="btn2 mt" data-act="captions-srt">${t("captions.saveSrt")}</div>` : ""}
  <div class="row2 mt"><div class="link" data-act="captions-style">${t("captions.changeStyle")}</div></div>`;
}

function busyBox(st: CaptionsState): string {
  const what =
    st.stage === "texting"
      ? "captions.texting"
      : st.stage === "placing"
        ? "captions.placing"
        : "captions.rendering";
  return `<div class="box"><div class="row"><span>${t(what)}</span></div>${
    st.last ? `<div class="small muted mt">${st.last}</div>` : ""
  }${
    st.jobId && st.stage !== "placing"
      ? `<div class="link mt" data-act="captions-cancel">${t("progress.stop")}</div>`
      : ""
  }</div>`;
}

export function captionsBox(st: CaptionsState, ctx: CaptionsCtx): string {
  const notes =
    (st.error
      ? `<div class="box warn">${ctx.esc(st.error)}${ctx.reportLink(st.error)}</div>`
      : "") +
    (st.notice ? `<div class="info">${ctx.esc(st.notice)}</div>` : "") +
    (st.stage === "placed" && st.placed
      ? `<div class="box ok">${t("captions.placed", { v: st.placed.videoTrack + 1 })}</div>`
      : "");
  // the notes keep a little room under the tabs
  const top = notes ? `<div class="cap-top">${notes}</div>` : "";
  if (st.stage === "texting" || st.stage === "rendering" || st.stage === "placing")
    return top + busyBox(st);
  if ((st.stage === "review" || st.stage === "placed") && st.lines.length)
    return top + reviewScreen(st);
  return top + stepOne(st, ctx);
}

// ---------- jobs ----------

/** Starts a companion job and follows it; `onDone` gets its result, `onFail` its message. */
async function captionsJob(
  st: CaptionsState,
  ctx: CaptionsCtx,
  params: Record<string, unknown>,
  back: CaptionsState["stage"],
  onDone: (result: Record<string, unknown>) => void | Promise<void>,
  onFail?: (message: string) => boolean,
): Promise<void> {
  st.jobId = null;
  const off = ctx.on((m) => {
    if (m.jobId !== st.jobId || st.jobId === null) return;
    if (m.type === "job.progress") {
      st.last = String(m.message);
      ctx.render();
    } else if (m.type === "job.done") {
      off();
      st.jobId = null;
      void Promise.resolve(onDone(m.result as Record<string, unknown>)).then(() => ctx.render());
      ctx.render();
    } else if (m.type === "job.error" || m.type === "job.cancelled") {
      off();
      st.jobId = null;
      st.stage = back;
      const message = String(m.message ?? m.type);
      if (m.type === "job.cancelled") st.error = t("job.stopped");
      else if (!onFail?.(message)) st.error = t("captions.jobFailed", { message });
      ctx.trace(`captions: failed ${message}`);
      ctx.render();
    }
  });
  try {
    const accepted = await ctx.request(
      { type: "job.start", ref: String(Date.now()), params },
      "job.accepted",
    );
    st.jobId = String(accepted.jobId);
  } catch (err) {
    off();
    st.stage = back;
    st.error = t("captions.jobFailed", {
      message: err instanceof Error ? err.message : String(err),
    });
    ctx.render();
  }
}

function formatOf(target: HostSequence): "portrait" | "landscape" | "square" {
  return shapeOf(`${target.width}x${target.height}`) ?? "landscape";
}

/**
 * Marks the lines whose text differs from what Whisper heard over the same time. The correction keeps the
 * times (a joined word spans its sources, a split one shares its source's), so a heard word belongs to the line
 * its middle falls in.
 */
export function markChanged(lines: CaptionLine[], original: CaptionWord[]): CaptionLine[] {
  if (!original.length) return lines;
  return lines.map((line) => {
    const heard = original
      .filter((w) => {
        const mid = (w.start + w.end) / 2;
        return mid >= line.start - 0.01 && mid <= line.end + 0.01;
      })
      .map((w) => w.text.trim())
      .filter(Boolean)
      .join(" ");
    return heard === line.text ? line : { ...line, changed: true };
  });
}

/** Splits the words for the look in use, at the look's width for the sequence's format. */
function linesFor(st: CaptionsState, look: CaptionLook, format: CaptionsState["format"]): void {
  st.lines = markChanged(
    splitLines(st.words, { maxChars: look.maxChars[format], maxLines: look.maxLines }),
    st.original,
  );
  st.drafts = st.lines.map((l) => l.text);
  st.edited = false;
}

async function makeText(st: CaptionsState, ctx: CaptionsCtx): Promise<void> {
  // busy before the first wait: a second click must not start a second export and model call
  if (st.stage !== "idle") return;
  st.stage = "texting";
  st.error = null;
  st.notice = null;
  st.last = "";
  ctx.render();
  const target = await ctx.readSequence();
  if (!target) {
    st.stage = "idle";
    return ctx.render();
  }
  const inOut = ctx.inOut();
  const range: Range =
    st.scope === "range" && inOut
      ? inOut
      : {
          startS: 0,
          endS: target.endSeconds,
          durationS: target.endSeconds,
          source: "sequence",
          warning: null,
        };
  try {
    const prepared = await ctx.request(
      {
        type: "job.prepare",
        projectPath: target.projectPath,
        sequenceName: `${target.name} Captions`,
        ...(target.jobRoot ? { jobRoot: target.jobRoot } : {}),
      },
      "job.prepared",
    );
    const jobDir = String(prepared.jobDir);
    const audioPath = `${jobDir}/sequence.wav`;
    // the editor's own speech: Kilnframe's inserts and music over the range are switched off for the export
    const audio = await ctx.withoutOurInserts(target, range, () =>
      ctx.exportAudio(target, range, audioPath),
    );
    if (!audio.ok) throw new Error(t("job.exportFailed"));
    Object.assign(st, {
      jobDir,
      seqId: target.id,
      projectPath: target.projectPath,
      seqName: target.name,
      rangeStartS: range.startS,
      durationS: range.durationS,
      format: formatOf(target),
      placed: null,
    });
    await captionsJob(
      st,
      ctx,
      {
        kind: "captions-text",
        audioPath,
        // the written file starts at offsetSeconds in the sequence
        rangeStartS: Math.max(0, range.startS - audio.offsetSeconds),
        rangeEndS: range.endS - audio.offsetSeconds,
        outDir: jobDir,
        glossary: st.settings.glossary,
        mode: st.settings.mode,
        ...ctx.providerParams(),
      },
      "idle",
      (result) => {
        st.language = String(result.language ?? "");
        ctx.store(languageKey(target.id), st.language);
        st.words = (result.words as CaptionWord[]) ?? [];
        st.original = (result.original as CaptionWord[] | undefined) ?? [];
        st.correctionError = result.correctionError ? String(result.correctionError) : null;
        linesFor(st, lookOf(st, ctx.videoStyle()), st.format);
        st.stage = "review";
      },
      (message) => {
        if (!/no speech/i.test(message)) return false;
        st.notice = t("captions.noSpeech");
        return true;
      },
    );
  } catch (err) {
    st.stage = "idle";
    st.error = t("captions.jobFailed", {
      message: err instanceof Error ? err.message : String(err),
    });
    ctx.render();
  }
}

/** The lines with the editor's text: an emptied line is null. */
function withDrafts(st: CaptionsState): (CaptionLine | null)[] {
  return st.lines.map((l, i) => retimeLine(l, st.drafts[i] ?? l.text));
}

function setLines(st: CaptionsState, lines: (CaptionLine | null)[]): void {
  st.lines = lines.filter((l): l is CaptionLine => l !== null);
  st.drafts = st.lines.map((l) => l.text);
  st.edited = true;
}

function splitLine(st: CaptionsState, ctx: CaptionsCtx, i: number): void {
  const lines = withDrafts(st);
  const line = lines[i];
  if (!line || line.words.length < 2) return;
  const at = caretWord(st.drafts[i] ?? line.text, ctx.caret(`cap-line-${i}`));
  lines.splice(i, 1, ...splitLineAt(line, at));
  setLines(st, lines);
}

function mergeLine(st: CaptionsState, i: number): void {
  const lines = withDrafts(st);
  const a = lines[i];
  const j = lines.findIndex((l, k) => k > i && l !== null);
  if (!a || j < 0) return;
  lines[i] = mergeLines(a, lines[j]!);
  lines[j] = null;
  setLines(st, lines);
}

async function renderCaptions(st: CaptionsState, ctx: CaptionsCtx): Promise<void> {
  if ((st.stage !== "review" && st.stage !== "placed") || !st.jobDir) return;
  const lines = withDrafts(st).filter((l): l is CaptionLine => l !== null);
  if (!lines.length) return;
  st.stage = "rendering";
  st.error = null;
  st.notice = null;
  st.last = "";
  ctx.render();
  const target = await ctx.readSequence();
  if (!target || target.id !== st.seqId) {
    st.stage = st.placed ? "placed" : "review";
    if (target) st.error = t("captions.otherSequence");
    return ctx.render();
  }
  const back = st.stage === "rendering" && st.placed ? "placed" : "review";
  let hideSpans: { startS: number; endS: number }[] = [];
  if (!st.settings.overInserts) {
    try {
      hideSpans = (await ctx.ourInsertSpans(target))
        .map((s) => ({
          startS: Math.max(0, s.startS - st.rangeStartS),
          endS: Math.min(st.durationS, s.endS - st.rangeStartS),
        }))
        .filter((s) => s.endS > s.startS);
    } catch (err) {
      ctx.trace(`captions: insert spans failed ${String(err)}`);
    }
  }
  const look = lookOf(st, ctx.videoStyle());
  await captionsJob(
    st,
    ctx,
    {
      kind: "captions-render",
      doc: {
        lines,
        language: st.language ?? "",
        glossary: st.settings.glossary,
        durationS: st.durationS,
        width: target.width,
        height: target.height,
        fps: target.fps,
        hideSpans,
      },
      look: look.id,
      colors: colorsOf(st, look),
      outDir: st.jobDir,
    },
    back,
    (result) => place(st, ctx, target, String(result.video), String(result.srt), back),
  );
}

/** The new clip goes where the last one was when that one is untouched, else on a new track. */
async function place(
  st: CaptionsState,
  ctx: CaptionsCtx,
  target: HostSequence,
  video: string,
  srt: string,
  back: CaptionsState["stage"],
): Promise<void> {
  st.stage = "placing";
  ctx.render();
  const atS = st.rangeStartS;
  const durationS = st.durationS;
  try {
    const before = st.placed;
    const found = before
      ? await ctx.findCaptionClip(target, before.video, before.atS, before.durationS)
      : null;
    let videoTrack: number;
    if (before && found) {
      await ctx.replaceCaptionClip(target, before.video, video, atS, durationS, found.videoTrack);
      videoTrack = found.videoTrack;
    } else {
      videoTrack = (await ctx.placeInsert(target, { video, sfx: null }, atS, 0, durationS))
        .videoTrack;
      if (before) st.notice = t("captions.newTrack");
    }
    st.placed = { video, srt, atS, durationS, videoTrack };
    st.stage = "placed";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    st.error = message === t("premiere.placeFailed") ? t("captions.placeFailed") : message;
    st.stage = back;
  }
}

async function saveSrt(st: CaptionsState, ctx: CaptionsCtx): Promise<void> {
  const placed = st.placed;
  if (!placed) return;
  st.error = null;
  try {
    const text = await ctx.readTextFile(placed.srt);
    let where: string | null;
    if (ctx.saveTextFile) where = await ctx.saveTextFile(`${st.seqName || "captions"}.srt`, text);
    else {
      // no save dialog in this editor: next to the project, named after the sequence and the render
      const dir = st.projectPath.replace(/[\\/][^\\/]*$/, "");
      const name = placed.srt.split(/[\\/]/).pop() ?? "captions.srt";
      where = `${dir}/${st.seqName.replace(/[\\/:*?"<>|]/g, "-")} ${name}`;
      await ctx.writeTextFile(where, text);
    }
    if (where) st.notice = t("captions.srtSaved", { path: where });
  } catch (err) {
    st.error = t("captions.srtFailed", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
  ctx.render();
}

// ---------- actions ----------

const CAPTIONS_ACTS = new Set([
  "captions-scope",
  "captions-look",
  "captions-colors-reset",
  "captions-mode",
  "captions-over",
  "captions-make",
  "captions-back",
  "captions-style",
  "captions-cancel",
  "captions-split",
  "captions-merge",
  "captions-render",
  "captions-srt",
]);

/** The tab's clicks. Returns true when it handled `act`. */
export function captionsAct(
  st: CaptionsState,
  ctx: CaptionsCtx,
  act: string,
  val: string,
): boolean {
  if (!CAPTIONS_ACTS.has(act)) return false;
  if (act === "captions-scope") st.scope = val === "range" ? "range" : "all";
  else if (act === "captions-look" && val in CAPTION_LOOKS) {
    const look = CAPTION_LOOKS[val as CaptionStyleId];
    st.settings = { ...st.settings, look: look.id, colors: { ...look.colors } };
    saveSettings(st, ctx);
  } else if (act === "captions-colors-reset") {
    st.settings = { ...st.settings, colors: null };
    saveSettings(st, ctx);
  } else if (act === "captions-mode") {
    st.settings = { ...st.settings, mode: val === "spoken" ? "spoken" : "written" };
    saveSettings(st, ctx);
  } else if (act === "captions-over") {
    st.settings = { ...st.settings, overInserts: !st.settings.overInserts };
    saveSettings(st, ctx);
  } else if (act === "captions-make") {
    saveSettings(st, ctx);
    if (st.stage === "idle" && st.lines.length)
      Object.assign(st, { lines: [], drafts: [], words: [] });
    void makeText(st, ctx);
  } else if (act === "captions-style") st.stage = "idle";
  else if (act === "captions-back" && st.lines.length) {
    saveSettings(st, ctx);
    // another look wraps at its own width; lines the editor worked on stay as they are
    const typed = st.drafts.some((d, i) => d !== st.lines[i]?.text);
    if (!st.edited && !typed && st.words.length)
      linesFor(st, lookOf(st, ctx.videoStyle()), st.format);
    st.stage = st.placed ? "placed" : "review";
  } else if (act === "captions-cancel") {
    if (st.jobId) ctx.send({ type: "job.cancel", jobId: st.jobId });
  } else if (act === "captions-split") splitLine(st, ctx, Number(val));
  else if (act === "captions-merge") mergeLine(st, Number(val));
  else if (act === "captions-render") void renderCaptions(st, ctx);
  else if (act === "captions-srt") void saveSrt(st, ctx);
  return true;
}
