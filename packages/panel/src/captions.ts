// The Captions tab: the whole sequence or the In/Out range captioned in one of nine looks. Step one picks the
// look, its colours and the spelling, and asks the companion for the words (captions-text: Whisper, then the
// editor's text model corrects them). Step two shows the lines to read and fix as text only. Step three renders
// them as one transparent clip (captions-render), places it over the speech and saves the SRT on request.
// The looks are shown on the editor's own footage: one still per look over a frame of the sequence
// (captions-preview), and "Play" renders a short window of a line small and shows it over the footage.
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
  /** The looks' stills over the footage, as data URLs, each in its look's own colours. */
  tiles: Partial<Record<CaptionStyleId, string>>;
  /** What the tiles show: a new frame, sample line or grid asks for new ones. */
  tilesKey: string | null;
  /** Height over width of the stills (the sequence's shape). */
  tilesAspect: number;
  /** The selected look in the editor's colours. */
  tinted: { key: string; look: CaptionStyleId; image: string } | null;
  /** A job folder for previews made before there is any text. */
  previewDir: string | null;
  /** The line being prepared for "Play". */
  playing: number | null;
  /** The last "Play": its frames (and a small clip where the panel plays video). */
  play: {
    key: string;
    line: number;
    frames: string[];
    clip: string | null;
    at: number;
    aspect: number;
  } | null;
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
    tiles: {},
    tilesKey: null,
    tilesAspect: 9 / 16,
    tinted: null,
    previewDir: null,
    playing: null,
    play: null,
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
  /** A still of the sequence at `seconds` written into `dir`; its path, or null when none was written. */
  exportFrame(
    target: HostSequence,
    seconds: number,
    dir: string,
    name: string,
  ): Promise<string | null>;
  /** Whether the panel can play a small H.264 clip; otherwise "Play" steps through stills. */
  playsVideo(): boolean;
  /** An image element kept across renders (data URLs are slow to parse again). */
  img(key: string, src: string, width: number, height: number): string;
  /** New previews arrived: render, unless the editor is typing (then only the pictures change). */
  refresh(images: Record<string, string>): void;
  /** Shows another picture in a kept image element, without a render. */
  swapImage(key: string, src: string): void;
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
  if (st.seqId === next) return;
  // a finished text stays for its own sequence; rendering it asks for that sequence to be open
  if ((st.stage === "review" || st.stage === "placed") && st.lines.length) return;
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

/**
 * A look's tile: its still over the footage when there is one, else a small drawing of it (two words in its
 * colours, its box or pill, its case) while the still is on its way or the app is not connected.
 */
function lookTile(
  look: CaptionLook,
  sel: boolean,
  width: number,
  colors: CaptionColors,
  still: { src: string; aspect: number } | null,
  last: boolean,
  ctx: CaptionsCtx,
): string {
  const margin = last ? ";margin-right:0" : "";
  if (still) {
    // the still is the whole frame; the tile shows the captions' part of it, larger: a 16:9 window (square in
    // portrait) around where the look sets its lines
    const portrait = still.aspect > 1;
    const zoom = portrait ? 1.25 : still.aspect > 0.9 ? 1.5 : 1.7;
    const boxW = width - 4;
    // the same box as the drawings, so a row of stills and drawings lines up
    const boxH = portrait ? boxW : Math.round((width * 9) / 16) - 4;
    const fullW = Math.round(boxW * zoom);
    const fullH = Math.round(fullW * still.aspect);
    const centre = portrait ? 0.68 : 0.8;
    const top = Math.max(0, Math.min(fullH - boxH, Math.round(fullH * centre - boxH / 2)));
    const left = Math.round((fullW - boxW) / 2);
    return `<div class="tile${sel ? " sel" : ""}" style="width:${width}px${margin}" data-act="captions-look" data-val="${look.id}"><div class="tile-img cap-still" style="width:${boxW}px;height:${boxH}px"><div style="margin-top:-${top}px;margin-left:-${left}px;width:${fullW}px">${ctx.img(`cap:${look.id}`, still.src, fullW, fullH)}</div></div><div class="tile-name">${sel ? "✓ " : ""}${look.name[lang()]}</div></div>`;
  }
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
  return `<div class="tile${sel ? " sel" : ""}" style="width:${width}px${margin}" data-act="captions-look" data-val="${look.id}"><div class="tile-img cap-frame" style="width:${width - 4}px;height:${height - 4}px"><div class="cap-sample${family}" style="${font};${box ? `background:${box};` : ""}"><span class="cw" style="color:${colors.text}">${up(a)}</span> ${second}</div></div><div class="tile-name">${sel ? "✓ " : ""}${look.name[lang()]}</div></div>`;
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
        `<div class="swatch"><div class="chip" id="cap-chip-${k}" style="background:${ctx.esc(colors[k] ?? "")}"></div><div class="swatch-text"><div class="small muted">${t(`captions.color.${k}`)}</div><input class="img-note" id="cap-color-${k}" type="text" value="${ctx.esc(colors[k] ?? "")}"></div></div>`,
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
  wantTiles(st, ctx);
  const tiles = captionGrid(ctx.videoStyle())
    .map((id, i) => {
      const l = CAPTION_LOOKS[id];
      const sel = id === look.id;
      // the selected look in the editor's colours once that still is here; until then its own
      const src = (sel && st.tinted?.look === id ? st.tinted.image : null) ?? st.tiles[id];
      const still = src ? { src, aspect: st.tilesAspect } : null;
      return lookTile(l, sel, width, sel ? colorsOf(st, l) : l.colors, still, i % 3 === 2, ctx);
    })
    .join("");
  const hasText = st.lines.length > 0;
  return `${ctx.rangeLine(range ? st.scope : "all")}
  <div class="lbl">${t("captions.scope")}</div>
  ${ctx.seg("captions-scope", range ? st.scope : "all", scopes)}
  <div class="lbl">${t("captions.look")}</div>
  <div class="tiles cap-tiles">${tiles}</div>
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
      : `<div class="btn mt${ctx.connected() ? "" : " off"}" data-act="captions-make"${ctx.connected() ? "" : " disabled"}>${t("captions.make")}</div>`
  }`;
}

/** The last "Play" under its line: the small clip, or its stills one after another. */
function player(st: CaptionsState, ctx: CaptionsCtx): string {
  const play = st.play;
  if (!play) return "";
  // the line's row is indented by its marker
  const width = Math.min(ctx.tileWidth() * 3 + 16 - 10, play.aspect > 1 ? 200 : 9999);
  const height = Math.round(width * play.aspect);
  if (play.clip && ctx.playsVideo())
    return `<video class="cap-player" src="${play.clip}" width="${width}" height="${height}" autoplay loop muted playsinline></video>`;
  const src = play.frames[play.at] ?? play.frames[0];
  return src ? `<div class="cap-player">${ctx.img("cap-play", src, width, height)}</div>` : "";
}

function lineRows(st: CaptionsState, ctx: CaptionsCtx): string {
  return st.lines
    .map((line, i) => {
      const words = (st.drafts[i] ?? line.text).split(/\s+/).filter(Boolean).length;
      const links = [
        st.playing === i
          ? `<div class="link cap-wait">${t("captions.playing")}</div>`
          : `<div class="link" data-act="captions-play" data-val="${i}">${t("captions.play")}</div>`,
        words > 1
          ? `<div class="link" data-act="captions-split" data-val="${i}">${t("captions.split")}</div>`
          : "",
        i < st.lines.length - 1
          ? `<div class="link" data-act="captions-merge" data-val="${i}">${t("captions.merge")}</div>`
          : "",
      ].join("");
      return `<div class="cline${line.changed ? " changed" : ""}"><div class="row small muted"><span>${clock(st.rangeStartS + line.start)}</span>${
        line.changed ? `<span class="ctag">${t("captions.changed")}</span>` : ""
      }</div><textarea class="cline-text" id="cap-line-${i}"></textarea><div class="row2">${links}</div>${
        st.play?.line === i && st.playing !== i ? player(st, ctx) : ""
      }</div>`;
    })
    .join("");
}

function reviewScreen(st: CaptionsState, ctx: CaptionsCtx): string {
  const placed = st.stage === "placed" && st.placed;
  const fixed = st.correctionError
    ? `<div class="small warn-text">${t("captions.notCorrected")}</div>`
    : `<div class="small muted">${t("captions.checkHelp")}</div>`;
  return `<div class="lbl">${t("captions.check")}</div>${fixed}
  <div class="clines">${lineRows(st, ctx)}</div>
  <div class="btn mt" data-act="captions-render">${t(placed ? "captions.rerender" : "captions.render")}</div>
  ${placed ? `<div class="btn2 mt" data-act="captions-srt">${t("captions.saveSrt")}</div>` : ""}
  <div class="row2 mt"><div class="link" data-act="captions-style">${t("captions.changeStyle")}</div></div>`;
}

function busyBox(st: CaptionsState, ctx: CaptionsCtx): string {
  const what =
    st.stage === "texting"
      ? "captions.texting"
      : st.stage === "placing"
        ? "captions.placing"
        : "captions.rendering";
  return `<div class="box"><div class="row"><span>${t(what)}</span></div>${
    st.last ? `<div class="small muted mt">${ctx.esc(st.last)}</div>` : ""
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
    return top + busyBox(st, ctx);
  if ((st.stage === "review" || st.stage === "placed") && st.lines.length)
    return top + reviewScreen(st, ctx);
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
  if (st.stage !== "idle" || !ctx.connected()) return;
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
    // the previews' folder, when they already made one for this sequence
    const jobDir =
      st.previewDir && st.seqId === target.id ? st.previewDir : await prepareDir(ctx, target);
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
      // a new transcript of the same sequence still replaces the clip placed before
      placed: target.id === st.seqId ? st.placed : null,
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
  if (!lines.length) {
    st.notice = t("captions.noLines");
    return ctx.render();
  }
  const back = st.stage;
  st.stage = "rendering";
  st.error = null;
  st.notice = null;
  st.last = "";
  ctx.render();
  const target = await ctx.readSequence();
  if (!target || target.id !== st.seqId) {
    st.stage = back;
    if (target) st.error = t("captions.otherSequence");
    return ctx.render();
  }
  const hideSpans = await hiddenSpans(st, ctx, target, 0, st.durationS);
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

/**
 * Where the captions stay hidden (under Kilnframe's animations, unless the editor wants them over those too),
 * in the time of a doc that starts `fromS` into the range and lasts `durationS`.
 */
async function hiddenSpans(
  st: CaptionsState,
  ctx: CaptionsCtx,
  target: HostSequence,
  fromS: number,
  durationS: number,
): Promise<{ startS: number; endS: number }[]> {
  if (st.settings.overInserts) return [];
  try {
    const zero = st.rangeStartS + fromS;
    return (await ctx.ourInsertSpans(target))
      .map((s) => ({
        startS: Math.max(0, s.startS - zero),
        endS: Math.min(durationS, s.endS - zero),
      }))
      .filter((s) => s.endS > s.startS);
  } catch (err) {
    ctx.trace(`captions: insert spans failed ${String(err)}`);
    return [];
  }
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

async function prepareDir(ctx: CaptionsCtx, target: HostSequence): Promise<string> {
  const prepared = await ctx.request(
    {
      type: "job.prepare",
      projectPath: target.projectPath,
      sequenceName: `${target.name} Captions`,
      ...(target.jobRoot ? { jobRoot: target.jobRoot } : {}),
    },
    "job.prepared",
  );
  return String(prepared.jobDir);
}

// ---------- previews ----------

/**
 * One preview of a kind at a time. A request equal to the running one is dropped; another waits, and a later
 * one takes its place: when the running preview ends, only the latest request runs.
 */
interface PreviewQueue {
  running: string | null;
  next: { key: string; run: () => Promise<void> } | null;
}

const queues = new WeakMap<CaptionsState, Record<"tiles" | "tint" | "play", PreviewQueue>>();

function queueOf(st: CaptionsState, kind: "tiles" | "tint" | "play"): PreviewQueue {
  let q = queues.get(st);
  if (!q) {
    q = {
      tiles: { running: null, next: null },
      tint: { running: null, next: null },
      play: { running: null, next: null },
    };
    queues.set(st, q);
  }
  return q[kind];
}

function enqueue(q: PreviewQueue, key: string, run: () => Promise<void>): void {
  if (q.running === key) {
    q.next = null;
    return;
  }
  if (q.running !== null) {
    q.next = { key, run };
    return;
  }
  q.running = key;
  // never inside the render that asked for it
  void Promise.resolve()
    .then(run)
    .catch(() => undefined)
    .finally(() => {
      q.running = null;
      const next = q.next;
      q.next = null;
      if (next) enqueue(q, next.key, next.run);
    });
}

/** Starts a preview job and waits for its result; it leaves the tab's own job and stage alone. */
function previewJob(
  ctx: CaptionsCtx,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let id: string | null = null;
    const early: ServerMessage[] = [];
    const handle = (m: ServerMessage) => {
      if (m.type === "job.done") {
        off();
        resolve((m.result ?? {}) as Record<string, unknown>);
      } else if (m.type === "job.error" || m.type === "job.cancelled") {
        off();
        reject(new Error(String(m.message ?? m.type)));
      }
    };
    const off = ctx.on((m) => {
      if (!m.jobId) return;
      if (id === null) early.push(m);
      else if (m.jobId === id) handle(m);
    });
    ctx
      .request({ type: "job.start", ref: `preview-${Date.now()}`, params }, "job.accepted")
      .then((accepted) => {
        id = String(accepted.jobId);
        for (const m of early) if (m.jobId === id) handle(m);
      })
      .catch((err: unknown) => {
        off();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
  });
}

/** A quarter of the sequence's size in even numbers: previews are small, and four times faster to render. */
function quarter(target: HostSequence): { width: number; height: number } {
  const even = (n: number) => Math.max(2, Math.round(n / 8) * 2);
  return { width: even(target.width), height: even(target.height) };
}

const SAMPLE_TEXT = { tr: "Bugün bunu birlikte yapacağız.", en: "Let's make this together today." };

/** The tiles' line: the transcript's first one when there is one, else the look's sample in the speech's language. */
function sampleLine(st: CaptionsState): { line: CaptionLine; language: string } {
  const first = withDrafts(st).find((l): l is CaptionLine => l !== null);
  if (first) {
    const shift = 0.2 - first.start;
    const words = first.words.map((w) => ({ ...w, start: w.start + shift, end: w.end + shift }));
    return {
      line: { ...first, start: first.start + shift, end: first.end + shift, words },
      language: st.language || (lang() === "tr" ? "tr" : "en"),
    };
  }
  const language = turkishSpeech(st) ? "tr" : "en";
  const text = SAMPLE_TEXT[language];
  const words = text
    .split(" ")
    .map((w, i) => ({ text: w, start: 0.2 + i * 0.3, end: 0.48 + i * 0.3 }));
  return {
    line: { start: 0.2, end: words[words.length - 1]!.end, text, words, changed: false },
    language,
  };
}

/** A moment when the whole line is up and its last word is the spoken one. */
function stillMoment(line: CaptionLine): number {
  const last = line.words[line.words.length - 1];
  if (!last) return (line.start + line.end) / 2;
  return last.start + Math.min(0.15, (last.end - last.start) / 2);
}

/** The folder previews write into: the text's job folder, else one made for the previews. */
async function previewFolder(
  st: CaptionsState,
  ctx: CaptionsCtx,
  target: HostSequence,
): Promise<string> {
  if (st.jobDir && st.seqId === target.id) return st.jobDir;
  if (!st.previewDir) st.previewDir = await prepareDir(ctx, target);
  return st.previewDir;
}

let frameCount = 0;

/** A frame of the editor's footage, or null (the previews then lie over a dark ground). */
async function footageFrame(
  ctx: CaptionsCtx,
  target: HostSequence,
  dir: string,
  seconds: number,
): Promise<string | null> {
  try {
    return await ctx.exportFrame(target, seconds, dir, `caption-frame-${++frameCount}.png`);
  } catch (err) {
    ctx.trace(`captions: frame failed ${String(err)}`);
    return null;
  }
}

function tilesKeyOf(st: CaptionsState, ctx: CaptionsCtx): string {
  const range = st.scope === "range" ? ctx.inOut() : null;
  return JSON.stringify([
    st.seqId,
    range ? [range.startS, range.endS] : "all",
    sampleLine(st).line.text,
    captionGrid(ctx.videoStyle()),
  ]);
}

/** Step 1 is shown: each look's still over the footage, once per sequence, range, line and grid. */
function wantTiles(st: CaptionsState, ctx: CaptionsCtx): void {
  if (!st.seqId || !ctx.connected()) return;
  const key = tilesKeyOf(st, ctx);
  if (st.tilesKey === key) {
    wantTint(st, ctx);
    return;
  }
  st.tilesKey = key;
  enqueue(queueOf(st, "tiles"), key, async () => {
    try {
      const target = await ctx.readSequence();
      if (!target || target.id !== st.seqId) return;
      const dir = await previewFolder(st, ctx, target);
      const inOut = st.scope === "range" ? ctx.inOut() : null;
      const range = inOut ?? { startS: 0, durationS: target.endSeconds };
      const frame = await footageFrame(ctx, target, dir, range.startS + range.durationS / 3);
      const size = quarter(target);
      const { line, language } = sampleLine(st);
      const result = await previewJob(ctx, {
        kind: "captions-preview",
        doc: {
          lines: [line],
          language,
          glossary: st.settings.glossary,
          durationS: line.end + 0.5,
          ...size,
          fps: target.fps,
          hideSpans: [],
        },
        looks: captionGrid(ctx.videoStyle()),
        atS: stillMoment(line),
        ...(frame ? { frame } : {}),
        outDir: `${dir}/preview`,
      });
      if (st.tilesKey !== key) return;
      const images = (result.images ?? {}) as Record<string, string | null>;
      st.tiles = {};
      for (const [look, src] of Object.entries(images))
        if (src && look in CAPTION_LOOKS) st.tiles[look as CaptionStyleId] = src;
      st.tilesAspect = size.height / size.width;
      st.tinted = null;
      ctx.refresh(Object.fromEntries(Object.entries(st.tiles).map(([k, v]) => [`cap:${k}`, v])));
      wantTint(st, ctx);
    } catch (err) {
      ctx.trace(`captions: preview failed ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

/** The selected look in the editor's own colours, when they differ from the look's. */
function wantTint(st: CaptionsState, ctx: CaptionsCtx): void {
  if (!st.seqId || !st.tilesKey || !ctx.connected()) return;
  const look = lookOf(st, ctx.videoStyle());
  const colors = colorsOf(st, look);
  if (JSON.stringify(colors) === JSON.stringify(look.colors)) return;
  const key = JSON.stringify([st.tilesKey, look.id, colors]);
  if (st.tinted?.key === key) return;
  const tilesKey = st.tilesKey;
  enqueue(queueOf(st, "tint"), key, async () => {
    try {
      const target = await ctx.readSequence();
      if (!target || target.id !== st.seqId) return;
      const dir = await previewFolder(st, ctx, target);
      const inOut = st.scope === "range" ? ctx.inOut() : null;
      const range = inOut ?? { startS: 0, durationS: target.endSeconds };
      const frame = await footageFrame(ctx, target, dir, range.startS + range.durationS / 3);
      const { line, language } = sampleLine(st);
      const result = await previewJob(ctx, {
        kind: "captions-preview",
        doc: {
          lines: [line],
          language,
          glossary: st.settings.glossary,
          durationS: line.end + 0.5,
          ...quarter(target),
          fps: target.fps,
          hideSpans: [],
        },
        looks: [look.id],
        colors,
        atS: stillMoment(line),
        ...(frame ? { frame } : {}),
        outDir: `${dir}/preview`,
      });
      const image = ((result.images ?? {}) as Record<string, string | null>)[look.id];
      if (!image || st.tilesKey !== tilesKey) return;
      st.tinted = { key, look: look.id, image };
      ctx.refresh({ [`cap:${look.id}`]: image });
    } catch (err) {
      ctx.trace(`captions: preview failed ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

const colorTimers = new WeakMap<CaptionsState, ReturnType<typeof setTimeout>>();

/**
 * The editor is typing a colour: 400 ms after the last change the typed colours are taken and the selected
 * look is previewed in them. `read` gives the colours in the fields (null: nothing valid changed).
 */
export function captionsColorInput(
  st: CaptionsState,
  ctx: CaptionsCtx,
  read: () => CaptionColors | null,
): void {
  clearTimeout(colorTimers.get(st));
  colorTimers.set(
    st,
    setTimeout(() => {
      colorTimers.delete(st);
      const colors = read();
      if (!colors) return;
      st.settings = { ...st.settings, colors };
      saveSettings(st, ctx);
      wantTint(st, ctx);
    }, 400),
  );
}

/** The colours in the colour fields, for `captionsColorInput`; the fields then count as taken. */
export function readColorFields(): CaptionColors | null {
  const fields: ColorFields = {};
  for (const key of COLOR_KEYS) {
    const el = document.getElementById(`cap-color-${key}`) as HTMLInputElement | null;
    if (el) fields[key] = { shown: el.getAttribute("value") ?? "", typed: el.value ?? "" };
  }
  const colors = typedColors(fields);
  settleColorFields();
  return colors;
}

/**
 * The colour fields as they stand count as shown: the next render reads no change from them. Clicking
 * another look must not carry the colours typed for the last one over to it.
 */
function settleColorFields(): void {
  if (typeof document === "undefined") return;
  for (const key of COLOR_KEYS) {
    const el = document.getElementById(`cap-color-${key}`) as HTMLInputElement | null;
    if (!el) continue;
    el.setAttribute("value", el.value ?? "");
    // the swatch follows a valid colour at once; a render would take the focus from the field
    const chip = document.getElementById(`cap-chip-${key}`);
    if (chip && COLOR.test((el.value ?? "").trim())) chip.style.background = el.value.trim();
  }
}

const PLAY_S = 2.5;
const PLAY_STILLS = 6;

/** The 2.5 s around a line's middle, inside the captioned range. */
function playWindow(line: CaptionLine, durationS: number): { fromS: number; toS: number } {
  const length = Math.min(PLAY_S, durationS);
  const fromS = Math.max(0, Math.min(durationS - length, (line.start + line.end) / 2 - length / 2));
  return { fromS, toS: fromS + length };
}

/** The lines inside the window, in its own time. */
function windowLines(lines: CaptionLine[], fromS: number, toS: number): CaptionLine[] {
  const at = (s: number) => Math.min(toS - fromS, Math.max(0, s - fromS));
  return lines
    .filter((l) => l.end > fromS && l.start < toS)
    .map((l) => ({
      ...l,
      start: at(l.start),
      end: at(l.end),
      words: l.words.map((w) => ({ ...w, start: at(w.start), end: at(w.end) })),
    }));
}

let flipTimer: ReturnType<typeof setInterval> | null = null;

/** Steps through the play's stills in time, three times over, then rests on the last. */
function flip(st: CaptionsState, ctx: CaptionsCtx): void {
  if (flipTimer) clearInterval(flipTimer);
  flipTimer = null;
  const play = st.play;
  if (!play || play.frames.length < 2 || (play.clip && ctx.playsVideo())) return;
  let step = 0;
  const total = play.frames.length * 3;
  flipTimer = setInterval(
    () => {
      step++;
      if (st.play !== play || step >= total) {
        if (flipTimer) clearInterval(flipTimer);
        flipTimer = null;
        return;
      }
      play.at = step % play.frames.length;
      ctx.swapImage("cap-play", play.frames[play.at]!);
    },
    (PLAY_S * 1000) / play.frames.length,
  );
}

/** "Play": the line's window rendered small in the selected look, over a frame of the footage. */
function playLine(st: CaptionsState, ctx: CaptionsCtx, i: number): void {
  const lines = withDrafts(st);
  const line = lines[i];
  if (!line || !st.jobDir || !ctx.connected()) return;
  const look = lookOf(st, ctx.videoStyle());
  const colors = colorsOf(st, look);
  const key = JSON.stringify([i, line.text, look.id, colors, st.settings.overInserts]);
  if (st.play?.key === key) {
    st.play.at = 0;
    ctx.render();
    flip(st, ctx);
    return;
  }
  const jobDir = st.jobDir;
  enqueue(queueOf(st, "play"), key, async () => {
    st.playing = i;
    ctx.render();
    try {
      const target = await ctx.readSequence();
      if (!target || target.id !== st.seqId) throw new Error(t("captions.otherSequence"));
      const { fromS, toS } = playWindow(line, st.durationS);
      const frame = await footageFrame(ctx, target, jobDir, st.rangeStartS + (fromS + toS) / 2);
      const size = quarter(target);
      const result = await previewJob(ctx, {
        kind: "captions-render",
        doc: {
          lines: windowLines(
            lines.filter((l): l is CaptionLine => l !== null),
            fromS,
            toS,
          ),
          language: st.language ?? "",
          glossary: st.settings.glossary,
          durationS: toS - fromS,
          ...size,
          fps: target.fps,
          hideSpans: await hiddenSpans(st, ctx, target, fromS, toS - fromS),
        },
        look: look.id,
        colors,
        outDir: `${jobDir}/preview`,
        preview: {
          ...(frame ? { frame } : {}),
          stills: PLAY_STILLS,
          video: ctx.playsVideo(),
        },
      });
      st.play = {
        key,
        line: i,
        frames: ((result.frames as string[] | undefined) ?? []).filter(Boolean),
        clip: typeof result.clip === "string" ? result.clip : null,
        at: 0,
        aspect: size.height / size.width,
      };
    } catch (err) {
      st.notice = t("captions.playFailed", {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      st.playing = null;
      ctx.render();
      flip(st, ctx);
    }
  });
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
  "captions-play",
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
    settleColorFields();
    const look = CAPTION_LOOKS[val as CaptionStyleId];
    st.settings = { ...st.settings, look: look.id, colors: { ...look.colors } };
    saveSettings(st, ctx);
  } else if (act === "captions-colors-reset") {
    settleColorFields();
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
  else if (act === "captions-play") playLine(st, ctx, Number(val));
  return true;
}
