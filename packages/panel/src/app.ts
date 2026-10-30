// The Kilnframe panel: home, progress and settings screens. Plain DOM, no framework: UXP supports a subset of
// the web platform.
import { PROTOCOL_VERSION, protocolMismatch } from "./companion";
import { CompanionSession, type ServerMessage } from "./companion-session";
import { homeDirNow, isWindows } from "./home";
import { audioRangeParams } from "./audio-range";
import { host, type Host, type HostSequence, type PlaceResult } from "./host";
import { addCosts, formatTokens, formatUsd, type JobCost } from "./cost";
import { lmStudioDefault, lmStudioRows, prettyModel, type ServedModel } from "./models";
import {
  musicAct,
  musicBox,
  musicReadFields,
  musicWriteFields,
  newMusic,
  watchesSequence,
  type MusicCtx,
} from "./music";
import {
  captionsAct,
  captionsBox,
  captionsColorInput,
  captionsLineInput,
  captionsReconnected,
  captionsReadFields,
  captionsSwitch,
  captionsWriteFields,
  readColorFields,
  newCaptions,
  type CaptionsCtx,
} from "./captions";
import { NOT_REPORTED, feedbackPage, shouldReport } from "./feedback";
import {
  LONG_RANGE_SECONDS,
  STORY_LENGTH,
  footageFrameTimes,
  framesForRange,
  type FootageFrame,
  parseLength,
  formatDuration,
  formatTimecode,
  pickRange,
  type Range,
} from "./range";
import {
  STEP_COUNT,
  detailOf,
  parsePlanLine,
  redoSceneLabel,
  sceneName,
  stepLabel,
  stepOf,
  subProgress,
  techniqueName,
  type PlannedScene,
} from "./steps";
import { formatMismatch } from "./format-check";
import { readableJobText } from "./job-errors";
import { isOtherVideo, videoBusy } from "./video-switch";
import { rangeWatch, within, type QuickRange } from "./range-watch";
import { storyMusicNote } from "./story-music";
import { OWN_MAX_S, ownParagraphs, ownSummary, ownTitle, storySeconds } from "./story-own";
import { MIN_PREMIERE } from "./premiere-version";
import { lang, localized, pickLang, setLang, t, type LangSetting, type MessageKey } from "./i18n";

/** Name and description come per language from the style's tokens.json. */
type Localized = string | Partial<Record<"en" | "tr", string>>;

interface StyleCard {
  name: string;
  displayName: Localized;
  description: Localized;
  summary: string;
  thumb: string | null;
  /** The style's reference stills, 16:9, for the gallery. */
  stills?: string[];
  /** A style the editor made (Your Own Style). */
  custom?: boolean;
  /** Stills with words in another language, picked when the panel runs in it. */
  byLang?: Record<string, { thumb: string | null; stills: string[] }>;
}

/** The style's stills in the panel's language: its own words when it has them, else the shared ones. */
function styleStills(s: StyleCard): { thumb: string | null; stills: string[] } {
  const own = s.byLang?.[lang()];
  const thumb = own?.thumb ?? s.thumb;
  const stills = own?.stills.length
    ? own.stills
    : s.stills?.length
      ? s.stills
      : thumb
        ? [thumb]
        : [];
  return { thumb: thumb ?? stills[0] ?? null, stills };
}

/** An image the editor picked, as the companion described it (packages/companion/src/panel-support.ts). */
interface PickedImage {
  path: string;
  name: string;
  width?: number;
  height?: number;
  hasAlpha?: boolean;
  thumb?: string;
  error?: "unsupported" | "missing" | "unreadable";
  note: string;
}

const MAX_IMAGES = 12;

/** Story mode: brief, narration, voice, new sequence. */
interface StoryState {
  stage: "brief" | "writing" | "script" | "voicing" | "done";
  brief: string;
  durationS: number;
  /** One of the length buttons, or "custom" with the editor's own length typed in customLength. */
  lengthChoice: "30" | "60" | "120" | "custom";
  customLength: string;
  language: "tr" | "en";
  tone: string;
  title: string;
  voiceStyle: string;
  script: string;
  note: string;
  voice: string;
  /** A Lyria music bed on A2, in the chosen style's mood. */
  music: "on" | "off";
  /** The new sequence's frame; "orijinal" keeps the open sequence's. */
  format: Format;
  voices: { name: string; character: string }[];
  /** The whole voice list is open. */
  allVoices: boolean;
  keySet: boolean;
  jobId: string | null;
  last: string;
  error: string | null;
  done: { name: string; durationS: number; musicNote?: string } | null;
  /** "own": the editor pastes a text written elsewhere, no model writes it. */
  source: "write" | "own";
  own: string;
}

function newStory(): StoryState {
  return {
    stage: "brief",
    brief: "",
    durationS: 60,
    lengthChoice: "60",
    customLength: "",
    language: lang() === "tr" ? "tr" : "en",
    tone: "",
    title: "",
    voiceStyle: "",
    script: "",
    note: "",
    voice: stored("story-voice") ?? "Kore",
    music: stored("story-music") === "off" ? "off" : "on",
    format:
      (["landscape", "portrait", "square"] as const).find((f) => f === stored("story-format")) ??
      "orijinal",
    voices: [],
    allVoices: false,
    keySet: true,
    jobId: null,
    last: "",
    error: null,
    done: null,
    source: stored("story-source") === "own" ? "own" : "write",
    own: "",
  };
}

/** Voices that suit a narration, shown first (panel design, 8 Oct 2026). */
const NARRATION_VOICES = ["Charon", "Kore", "Sulafat", "Achernar"];

/** A voice's one-word character in the panel language; unknown words stay as the provider wrote them. */
function voiceCharacter(character: string): string {
  const key = `voice.${character}` as MessageKey;
  const text = t(key);
  return text === key ? character : text;
}

interface OwnStyle {
  stage: "new" | "running" | "review";
  description: string;
  refs: PickedImage[];
  jobId: string | null;
  last: string;
  startedAt: number;
  error: string | null;
  result: null | {
    name: string;
    displayName: Localized;
    notes: Localized;
    stillImages: StillImage[];
  };
  redoNote: string;
  confirmDelete: boolean;
}

/** A full-width view of one image: a style's reference stills or a scene's review still. */
interface Lightbox {
  kind: "style" | "still";
  images: { src: string; caption: string; sceneId?: string }[];
  index: number;
}

type Tab = "range" | "story" | "music" | "captions";
type Format = "orijinal" | "landscape" | "portrait" | "square";
type Mode = "auto" | "fullscreen" | "overlay";

interface Settings {
  /** auto, claude-code, an id from the companion's providers.json, or custom. */
  provider: string;
  /** The Claude model for auto, claude-code and anthropic. */
  model: string;
  /** The model chosen for every other provider. */
  models: Record<string, string>;
  /** Addresses the editor typed: the custom endpoint, and presets that need their own. */
  baseURLs: Record<string, string>;
  /** LM Studio's thinking for a model that thinks; off when not set. */
  thinking?: Record<string, "off" | "on">;
  /** Show the stills before the full render (default on). */
  review: "on" | "off";
  /** Panel language; "auto" follows Premiere. */
  lang: LangSetting;
  /** The Music tab's level under speech, as the editor's audio meter reads it (dBFS). */
  musicLevel?: number;
}

interface StillImage {
  sceneId: string;
  image: string | null;
  /** A small drawing in this still runs off the frame's edge: a note, the editor decides. */
  edgeCut?: boolean;
}

interface JobResult {
  outDir: string;
  output: string | null;
  sfxMix: string | null;
  handlesSeconds: number;
  durationSeconds: number;
  stillImages: StillImage[];
  plan: { width: number; height: number };
  /** The job's tokens and cost (usage.json); absent from an older companion. */
  cost?: JobCost | null;
}

/** The open review: the job's parameters are sent again to render or to redo one scene. */
interface Review {
  target: HostSequence;
  range: Range;
  params: Record<string, unknown>;
  stills: StillImage[];
  aspect: number;
  redo: string | null;
  note: string;
  /** A long range's review: the stills of every part, keyed "part:scene" (for example "1:s3"). */
  series?: boolean;
}

interface JobView {
  id: string | null;
  step: number;
  /** How far the current step is, 0 to 1, when the companion says so. */
  sub?: number;
  scenes: PlannedScene[];
  last: string;
  startedAt: number;
  error: string | null;
  /** The error is worth reporting (not a job the editor stopped). */
  reportable?: boolean;
  placed: PlaceResult | null;
  /** Something the editor should know about the job besides its result (Resolve's render settings). */
  note?: string;
  /** What the placed insert cost; for a long range, all its parts. */
  cost?: JobCost | null;
  /** Set when a long range finished: how many parts were placed. */
  partsPlaced?: number;
  /** The editor pressed Stop and is asked to confirm. */
  confirmStop?: boolean;
}

/**
 * A long range made in parts (core parts.ts). Kept in panel storage after every step, so a reloaded panel,
 * a restarted Premiere or companion picks it up where it stopped. With the stills review
 * on, every part's stills are made first and approved together, then the parts render one after another.
 */
interface SeriesPart {
  startS: number;
  endS: number;
  text: string;
  transcriptPath: string;
  outDir: string;
  /** new: nothing made yet; stills: ready to review; placed: rendered and on the timeline. */
  state: "new" | "stills" | "placed";
  /** A job running for this part, asked for again after a restart. */
  jobId: string | null;
}

interface Series {
  /** The sequence it belongs to. */
  guid: string;
  title: string;
  jobDir: string;
  base: Record<string, unknown>;
  parts: SeriesPart[];
  /** Where the first part went; the others join it on the same tracks. */
  tracks: PlaceResult | null;
  /** The parts placed so far, added up. */
  cost?: JobCost | null;
  /** stills: making every part's stills; render: rendering and placing the approved parts. */
  phase: "stills" | "render";
  /** Frames of the footage over the whole range; each part gets the ones inside it. */
  frames?: FootageFrame[];
  /**
   * Where the cut audio starts in the sequence: parts are timed in the audio file, so a part's place in the
   * sequence is its start plus this. 0 (or missing, in a series saved before Resolve) for Premiere.
   */
  audioOffset?: number;
}

/** The last or first words of a part, so the model knows what comes before and after it. */
function wordsAround(text: string, n: number, from: "start" | "end"): string {
  const words = text.split(/\s+/).filter(Boolean);
  return (from === "start" ? words.slice(0, n) : words.slice(-n)).join(" ");
}

const state = {
  screen: "home" as "home" | "progress" | "settings" | "review" | "own" | "setup",
  review: null as Review | null,
  conn: "connecting" as "connecting" | "ok" | "down",
  connError: "",
  /** Open Kilnframe was pressed; the panel connects as soon as the app answers. */
  opening: false,
  system: null as null | {
    wavPreset?: string | null;
    /** Premiere's H.264 preset for the range's picture (preview over the real footage). */
    previewPreset?: string | null;
    gpu?: { mode?: string; renderer?: string };
    speechModel?: { name: string; cached: boolean };
  },
  styles: [] as StyleCard[],
  style: "",
  /** The style grid is open: no style yet, or the editor pressed Change. */
  styleOpen: false,
  format: "orijinal" as Format,
  mode: "auto" as Mode,
  note: "",
  seq: null as null | {
    name: string;
    guid: string;
    range: Range;
    fps: string;
    fpsValue: number;
    size: string;
    /** The sequence's length: the Music tab can score all of it while an In/Out is set. */
    endS: number;
  },
  seqError: "",
  job: null as JobView | null,
  /** A long range made part by part, also when it was started before a reload. */
  series: loadSeries(),
  lightbox: null as Lightbox | null,
  /** The home screen's ways to make something: an animation for a range, a story, music, captions. */
  tab: "range" as Tab,
  story: newStory(),
  music: newMusic(),
  captions: newCaptions(),
  /** Your Own Style: the form, the running job and the result to review. */
  own: null as null | OwnStyle,
  images: [] as PickedImage[],
  imagesBusy: false,
  settings: loadSettings(),
  /** The app's own update, as the companion relays it. */
  update: null as null | {
    status: "checking" | "none" | "available" | "downloading" | "ready" | "error";
    current: string;
    version?: string;
    percent?: number;
    error?: string;
  },
  /** The voice whose sample is playing (story mode), so its row offers Stop. */
  voicePlaying: "",
  /** The editor pressed Update while a job ran; the companion refused. */
  updateBusy: false,
  /** Which side is out of date when the panel and the companion speak different protocols. */
  mismatch: null as null | "app" | "panel",
  /** The companion's version from its "ready", for the version line in the settings. */
  appVersion: null as string | null,
};

const session = new CompanionSession();
session.on((m) => {
  if (m.type === "app.update") {
    state.update = m.update as NonNullable<typeof state.update>;
    if (state.update.status !== "available") state.updateBusy = false;
    render();
  } else if (m.type === "speech.ended" || m.type === "audio.ended") {
    state.voicePlaying = "";
    state.music.playing = null;
    render();
  } else if (m.type === "app.update.busy") {
    state.updateBusy = true;
    render();
  }
});

// Steps and errors also go to ~/.kilnframe/panel-log.txt, so problems inside the editor can be read outside it.

/** A story sequence's own narration, when it is still on disk: cleaner to transcribe than the mix. */
async function storyNarration(guid: string): Promise<string | null> {
  const file = stored(`narration:${guid}`);
  if (!file) return null;
  return (await host().fileExists(file)) ? file : null;
}
const logLines: string[] = [];
function trace(line: string) {
  console.log(`[kilnframe] ${line}`);
  logLines.push(`${new Date().toISOString()} ${line}`);
  if (logLines.length > 200) logLines.shift();
  const home = homeDirNow();
  if (!home) return;
  host()
    .writeTextFile(`${home}/.kilnframe/panel-log.txt`, logLines.join("\n"))
    .catch(() => undefined);
}
const root = document.getElementById("app") as HTMLDivElement;

// ---------- storage (per-viewer conveniences only, wrapped so a missing store never breaks the panel) ----------

function stored(key: string): string | null {
  try {
    return localStorage.getItem(`kilnframe:${key}`);
  } catch {
    return null;
  }
}
/** Premiere exports the audio with its own WAV preset; Resolve renders the range itself and needs none. */
function wavPresetOk(): boolean {
  return host().kind !== "premiere" || Boolean(state.system?.wavPreset);
}
function store(key: string, value: string) {
  try {
    localStorage.setItem(`kilnframe:${key}`, value);
  } catch {
    // ignore
  }
}
function loadSettings(): Settings {
  try {
    return {
      provider: "auto",
      model: "claude-opus-5-5",
      models: {},
      baseURLs: {},
      review: "on",
      lang: "auto",
      ...JSON.parse(stored("settings") ?? "{}"),
    };
  } catch {
    return {
      provider: "auto",
      model: "claude-opus-5-5",
      models: {},
      baseURLs: {},
      review: "on",
      lang: "auto",
    };
  }
}

function applyLang() {
  setLang(pickLang(state.settings.lang, host().uiLocale()));
  // a story not started yet speaks the panel's language (the story is made before the language is known)
  if (state.story.stage === "brief" && !state.story.brief.trim())
    state.story.language = lang() === "tr" ? "tr" : "en";
}

/** 23.976 reads "23.98" in English and "23,98" in Turkish. */
function formatFps(fps: string, value: number): string {
  if (!fps.includes("/")) return fps;
  const text = value.toFixed(2);
  return lang() === "tr" ? text.replace(".", ",") : text;
}

// ---------- helpers ----------

// UXP returns null for an empty textarea's value, so anything may arrive here
const esc = (s: string | null | undefined) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function seg<T extends string>(name: string, value: T, options: [T, string][]) {
  return `<div class="seg">${options
    .map(
      ([v, label]) =>
        `<div data-act="${name}" data-val="${v}" class="opt${v === value ? " on" : ""}">${label}</div>`,
    )
    .join("")}</div>`;
}

const FORMAT_SIZE: Record<Exclude<Format, "orijinal">, string> = {
  landscape: "landscape",
  portrait: "portrait",
  square: "square",
};

// ---------- screens ----------

function header(title: string, right: string) {
  return `<div class="head"><span class="title">${title}</span>${right}</div>`;
}

/** Where the app is downloaded; the release page always has the newest installers. */
/** The value for the editor the panel runs in. */
const editorText = <T>(by: Record<Host["kind"], T>): T => by[host().kind];

const DOWNLOAD_URL = "https://github.com/erhanmeydan/kilnframe/releases/latest";

/** The app's update, or the side to update when the panel and the app do not match. */
function updateBox(): string {
  if (state.conn !== "ok") return "";
  if (state.mismatch === "app")
    return `<div class="box warn"><div>${t("mismatch.app")}</div><div class="btn2 mt" data-act="open-url" data-val="${DOWNLOAD_URL}">${t("mismatch.download")} ↗</div></div>`;
  if (state.mismatch === "panel")
    return `<div class="box warn">${t(editorText({ premiere: "mismatch.panel", resolve: "mismatch.panelResolve", filmcraft: "mismatch.panelFilmcraft" }))}</div>`;
  const u = state.update;
  if (!u || u.status === "none" || u.status === "checking") return "";
  const v = esc(u.version ?? "");
  // the release page carries the notes of what changed
  const notes = `https://github.com/erhanmeydan/kilnframe/releases/tag/v${encodeURIComponent(u.version ?? "")}`;
  if (u.status === "available")
    return `<div class="box update"><div>${t("update.ready", { v })}</div>${
      state.updateBusy ? `<div class="small muted mt">${t("update.busy")}</div>` : ""
    }<div class="btn2 mt" data-act="app-update">${t("update.install")}</div><div class="btn2 mt" data-act="open-url" data-val="${notes}">${t("update.whatsNew")} ↗</div></div>`;
  if (u.status === "downloading")
    return `<div class="box update">${t("update.downloading", { p: u.percent ?? 0 })}</div>`;
  if (u.status === "ready") return `<div class="box update">${t("update.restarting")}</div>`;
  return `<div class="box warn"><div>${t("update.failed")}</div><div class="small muted">${esc(
    u.error ?? "",
  )}</div><div class="btn2 mt" data-act="app-update">${t("conn.retry")}</div></div>`;
}

function connectionBox(): string {
  if (state.conn === "ok") return updateBox();
  if (state.conn === "connecting" && !state.opening)
    return `<div class="box muted">${t("conn.connecting")}</div>`;
  return downBox();
}

/** The app is not running: what to do, and a button that opens it (the raw reason stays in the log). */
function downBox(): string {
  if (state.opening) return `<div class="box muted">${t("conn.opening")}</div>`;
  return `<div class="box warn"><div>${t("conn.down")}</div><div class="small muted">${t("conn.downHelp")}</div><div class="btn2 mt" data-act="open-app">${t("conn.openApp")}</div><div class="btn2 mt" data-act="reconnect">${t("conn.retry")}</div></div>`;
}

/** Opens the app through kilnframe:// and connects as soon as it answers (up to 40 s). */
async function openApp() {
  state.opening = true;
  render();
  try {
    await host().openUrl("kilnframe://open");
    trace("connect: asked the app to open");
  } catch (err) {
    trace(`connect: open app failed ${String(err)}`);
  }
  const started = Date.now();
  while (Date.now() - started < 40_000) {
    await new Promise((r) => setTimeout(r, 2000));
    await connectCompanion();
    if (state.conn === "ok") break;
  }
  state.opening = false;
  render();
}

/** The Music tab's range line, like the range tab's: the In/Out or the whole sequence, as chosen. */
function musicRangeLine(scope: "all" | "range"): string {
  if (state.seqError) return `<div class="box warn">${esc(state.seqError)}</div>`;
  if (!state.seq) return `<div class="box muted">${t("seq.reading")}</div>`;
  const inOut = state.seq.range.source === "inout";
  const r =
    scope === "range" && inOut
      ? state.seq.range
      : { startS: 0, endS: state.seq.endS, durationS: state.seq.endS };
  const label = scope === "range" && inOut ? t("seq.range") : t("seq.whole");
  return `<div class="rangeline row"><span>${label} ${formatTimecode(r.startS)} → ${formatTimecode(
    r.endS,
  )}</span><span class="muted">${formatDuration(r.durationS)} · ${esc(formatFps(state.seq.fps, state.seq.fpsValue))} fps</span></div>`;
}

function rangeBox(): string {
  if (state.seqError) return `<div class="box warn">${esc(state.seqError)}</div>`;
  if (!state.seq) return `<div class="box muted">${t("seq.reading")}</div>`;
  const r = state.seq.range;
  const label = r.source === "inout" ? t("seq.range") : t("seq.whole");
  // made here, not when the range was read, so it follows a language change
  const warning =
    r.durationS > LONG_RANGE_SECONDS
      ? t("range.long", { duration: formatDuration(r.durationS) })
      : null;
  return `<div class="rangeline row"><span>${label} ${formatTimecode(r.startS)} → ${formatTimecode(
    r.endS,
  )}</span><span class="muted">${formatDuration(r.durationS)} · ${esc(formatFps(state.seq.fps, state.seq.fpsValue))} fps</span></div>${
    warning ? `<div class="info">${esc(warning)}</div>` : ""
  }`;
}

const SCROLLBAR = 16;

/** Usable width inside the panel; images are sized from it because UXP has no aspect-ratio. */
function contentWidth(): number {
  // the scroll area inside #app always shows its scrollbar (so the width never jumps): its width comes off
  // here as well as the padding
  return Math.max(240, (root.clientWidth || 320) - 24 - SCROLLBAR);
}

/**
 * The scroll area's inner width as laid out, for grids that fill the row exactly; the scrollbar is measured
 * rather than assumed (UXP always draws it, a browser may overlay it).
 */
function scrollInnerWidth(): number {
  const scroller = document.getElementById("scroll");
  return scroller && scroller.clientWidth > 0 ? scroller.clientWidth - 24 : contentWidth();
}

/** 16:9 height for a width, like the video. */
function h169(width: number): number {
  return Math.round((width * 9) / 16);
}

/**
 * Images are data URLs (the style thumbnails alone are about 700 KB). Parsing them again on every render made
 * clicks slow, so each image element is made once and moved into its slot after a render.
 */
const images = new Map<string, HTMLImageElement>();
const pendingSrc = new Map<string, string>();

function imgSlot(
  key: string,
  src: string,
  width: number,
  height: number,
  attrs = "",
  cls = "",
): string {
  pendingSrc.set(key, src);
  return `<div class="img-slot ${cls}" data-img="${esc(key)}" style="width:${width}px;height:${height}px" ${attrs}></div>`;
}

function fillImageSlots() {
  const slots = root.querySelectorAll("[data-img]");
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i] as HTMLElement;
    const key = slot.getAttribute("data-img") ?? "";
    const src = pendingSrc.get(key);
    if (!src) continue;
    let img = images.get(key);
    if (!img || img.getAttribute("src") !== src) {
      img = document.createElement("img");
      img.setAttribute("src", src);
      images.set(key, img);
    }
    slot.appendChild(img);
  }
  pendingSrc.clear();
}

function styleTile(s: StyleCard, width: number): string {
  const sel = s.name === state.style;
  const { thumb } = styleStills(s);
  const size = `style="width:${width}px;height:${h169(width)}px"`;
  return `<div class="tile${sel ? " sel" : ""}" style="width:${width}px" data-act="style" data-val="${s.name}">${
    thumb
      ? imgSlot(`thumb:${lang()}:${s.name}`, thumb, width, h169(width), "", "tile-img")
      : `<div class="tile-img" ${size}></div>`
  }<div class="tile-name">${sel ? "✓ " : ""}${esc(localized(s.displayName))}</div></div>`;
}

/** Styles that are planned but not shipped yet hold their place in the grid (4 x 3). */
const PLANNED: { name: string; label: MessageKey }[] = [
  { name: "gazete-editoryal", label: "style.gazete" },
];

function soonTile(label: string, width: number, mark: string, act = ""): string {
  return `<div class="tile soon" style="width:${width}px" ${act}><div class="tile-img soon-img" style="width:${width}px;height:${h169(width)}px"><div class="soon-mark${mark === "+" ? " plus" : ""}">${mark}</div></div><div class="tile-name">${esc(label)}</div></div>`;
}

/** Ten styles, the planned ones and "Your Own Style" last, in a fixed order. */
function styleGrid(width: number): string {
  const ready = new Set(state.styles.map((s) => s.name));
  const entries: { name: string; html: string }[] = state.styles
    .filter((s) => !s.custom)
    .map((s) => ({
      name: s.name,
      html: styleTile(s, width),
    }));
  for (const p of PLANNED)
    if (!ready.has(p.name))
      entries.push({ name: p.name, html: soonTile(t(p.label), width, t("style.soon")) });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return `<div class="tiles">${entries.map((e) => e.html).join("")}${soonTile(
    t("style.custom"),
    width,
    "+",
    `data-act="custom-style"`,
  )}</div>`;
}

/** The chosen style: its description and its reference stills, each opening the gallery. */
/** Cuts a text at a word to about n characters; UXP has no line clamp. */
function clip(text: string, n: number): string {
  if (text.length <= n) return text;
  const cut = text.slice(0, n);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), n - 12)).replace(/[,.;:]$/, "")}…`;
}

/** The chosen style folded to one row: thumbnail, name, a short description, Change; its stills below. */
function chosenStyle(s: StyleCard): string {
  const { thumb, stills } = styleStills(s);
  const count = Math.max(stills.length, 3);
  // every strip image but the last has a 5px gap on its right
  const width = Math.floor((contentWidth() - 5 * (count - 1)) / count);
  return `<div class="style-row">${
    thumb
      ? imgSlot(
          `chosen:${lang()}:${s.name}`,
          thumb,
          92,
          h169(92),
          `data-act="gallery" data-val="0"`,
          "style-thumb",
        )
      : ""
  }<div class="rec-text"><div class="rec-name">${esc(localized(s.displayName))}</div><div class="small muted">${esc(
    clip(localized(s.description) || s.summary, 70),
  )}</div></div><div class="link" data-act="style-change">${t("home.change")}</div></div>
  <div class="strip">${stills
    .map((src, i) =>
      imgSlot(
        `gal:${lang()}:${s.name}:${i}`,
        src,
        width,
        h169(width),
        `data-act="gallery" data-val="${i}"`,
        "strip-img",
      ),
    )
    .join("")}</div>`;
}

/** The bar's height; set here because UXP shrinks it to one line when the scroll area asks for more. */
const BAR_HEIGHT = 74;

/**
 * The scroll area takes what the bar leaves. UXP lays every box out as a flex item: a scroll area of 100%
 * squeezed the bar to 19 px, and neither flex-shrink nor an absolute bar helped (measured 8 Oct 2026).
 */
function fitScroll() {
  const scroller = document.getElementById("scroll");
  const bar = root.querySelector(".actionbar") as HTMLElement | null;
  if (!scroller) return;
  scroller.style.height = bar ? `${Math.max(120, root.clientHeight - BAR_HEIGHT)}px` : "100%";
  if (bar) bar.style.height = `${BAR_HEIGHT}px`;
}

/** The range tab's bar: what runs and how long, and the main button, always in view. */
function rangeBar(): string {
  const ready = state.conn === "ok" && state.seq && state.style && wavPresetOk();
  const d = state.seq?.range.durationS;
  const length = d
    ? `${formatDuration(d)}${d > LONG_RANGE_SECONDS ? ` · ${t("bar.inParts")}` : ""}`
    : "";
  return `<div class="actionbar"><div class="row small muted"><span>${providerLabel()}</span><span>${length}</span></div>
  <div class="btn${ready ? "" : " off"}" data-act="generate" ${ready ? "" : "disabled"}>${
    state.style ? t("home.generate") : t("home.pickFirst")
  }</div></div>`;
}

function home(): string {
  // three per row, in a fixed order: choosing a style only marks it
  const done = state.job?.placed ?? null;
  return `${header(`<span class="brand"><img src="icons/mark@2x.png" width="18" height="18" alt="">Kilnframe</span>`, `<div class="icon" data-act="settings" title="${t("home.settings")}">⚙</div>`)}
  ${connectionBox()}
  ${seg("tab", state.tab, [
    ["range", t("tab.range")],
    ["story", t("tab.story")],
    ["music", t("tab.music")],
    ["captions", t("tab.captions")],
  ])}
  ${
    state.tab === "story"
      ? storyBox()
      : state.tab === "music"
        ? musicBox(state.music, musicCtx)
        : state.tab === "captions"
          ? captionsBox(state.captions, captionsCtx)
          : rangeHome(done)
  }`;
}

/** A long range left unfinished (reload, restart, an error, or Continue Later): where it stands. */
function seriesBox(): string {
  const series = state.series;
  if (!series || seriesBusy) return "";
  const n = series.parts.length;
  const placed = series.parts.filter((p) => p.state === "placed").length;
  const ready = series.parts.filter((p) => p.state === "stills").length;
  return `<div class="pdetail"><div><b>${esc(series.title)}</b></div>
  <div class="small muted">${t("series.status", { placed, ready, n })}</div>
  <div class="pbtns"><div class="pbtn primary" data-act="series-continue">${t("series.continue")}</div><div class="pbtn" data-act="series-drop">${t("series.drop")}</div></div></div>`;
}

/** "This animation used 83k input and 166k output tokens, about $0.09." On a plan: what it would cost as API. */
function costLine(c: JobCost): string {
  const tr = lang() === "tr";
  const tokens = { i: formatTokens(c.inputTokens, tr), o: formatTokens(c.outputTokens, tr) };
  if (c.billing === "plan")
    return c.listPriceUsd
      ? t("home.costPlan", { ...tokens, usd: formatUsd(c.listPriceUsd, tr) })
      : t("home.costPlanOnly", tokens);
  return c.costUsd === null
    ? t("home.costUnknown", tokens)
    : t("home.cost", { ...tokens, usd: formatUsd(c.costUsd, tr) });
}

/** A short note when the chosen format is not the sequence's shape; the insert is still made as chosen. */
function formatWarning(): string {
  const m = state.seq ? formatMismatch(state.seq.size, state.format) : null;
  if (!m) return "";
  return `<div class="small warn-text mt">${t("format.mismatch", {
    sequence: t(`shape.${m.sequence}`),
    chosen: t(`shape.${m.chosen}`),
  })}</div>`;
}

/** The range tab: what the home screen always was. */
function rangeHome(done: JobView["placed"]): string {
  const chosen = state.styles.find((s) => s.name === state.style);
  const tileWidth = Math.floor((contentWidth() - 3 * 8) / 3);
  const many = state.job?.partsPlaced;
  return `${done ? `<div class="box ok">${many ? t("home.placedParts", { n: many, v: done.videoTrack + 1, a: done.audioTrack + 1 }) : t("home.placed", { v: done.videoTrack + 1, a: done.audioTrack + 1 })}</div>` : ""}
  ${done && state.job?.cost ? `<div class="small muted">${esc(costLine(state.job.cost))}</div>` : ""}
  ${state.job?.error ? `<div class="box warn">${esc(state.job.error)}${state.job.reportable ? reportLink(state.job.error) : ""}</div>` : ""}
  ${state.job?.note ? `<div class="box warn">${esc(state.job.note)}</div>` : ""}
  ${seriesBox()}
  ${rangeBox()}
  <div class="lbl">${t("home.style")}</div>
  ${
    chosen && !state.styleOpen
      ? chosenStyle(chosen)
      : `${styleGrid(tileWidth)}${ownStylesRow(tileWidth)}${chosen ? "" : `<div class="box muted">${t("home.pickStyle")}</div>`}`
  }
  <div class="lbl">${t("home.format")}</div>
  ${seg("format", state.format, [
    ["orijinal", t("format.original")],
    ["landscape", t("format.landscape")],
    ["portrait", t("format.portrait")],
    ["square", t("format.square")],
  ])}
  ${formatWarning()}
  <div class="lbl">${t("home.layout")}</div>
  ${seg("mode", state.mode, [
    ["auto", t("mode.auto")],
    ["fullscreen", t("mode.fullscreen")],
    ["overlay", t("mode.overlay")],
  ])}
  <div class="lbl">${t("home.note")}</div>
  <textarea id="note" rows="2" placeholder="${t("home.notePlaceholder")}">${esc(state.note)}</textarea>
  ${imagesBox("img")}
  ${slowNote()}
  ${
    state.conn === "ok" && state.system && !wavPresetOk()
      ? `<div class="note warn-text">${t("home.noWavPreset")}</div>`
      : ""
  }`;
}

/** The two image lists: the job's images (up to 12) and a new style's references (up to 4). */
type ImageList = "img" | "ref";
const MAX_REFS = 4;

function imageList(kind: ImageList): PickedImage[] {
  return kind === "img" ? state.images : (state.own?.refs ?? []);
}

/** Thumbnails three per row, a note and a remove button each, then the add button. */
function imagesBox(kind: ImageList): string {
  const list = imageList(kind);
  const max = kind === "img" ? MAX_IMAGES : MAX_REFS;
  const width = Math.floor((contentWidth() - 3 * 8) / 3);
  const height = h169(width);
  const cards = list
    .map((img, i) => {
      let thumb = `<div class="img-box" style="width:${width}px;height:${height}px"></div>`;
      if (img.thumb && img.width && img.height) {
        // fit inside the 16:9 box without stretching
        const scale = Math.min(width / img.width, height / img.height);
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        thumb = `<div class="img-box${img.hasAlpha ? " checker" : ""}" style="width:${width}px;height:${height}px">${imgSlot(`${kind}:${img.path}`, img.thumb, w, h)}</div>`;
      }
      const problem = img.error
        ? `<div class="small warn-text">${t(`images.${img.error}`)}</div>`
        : "";
      return `<div class="img-card" style="width:${width}px">${thumb}<div class="row small"><span class="img-name">${esc(img.name)}</span><span class="img-x" data-act="remove-${kind}" data-val="${i}" title="${t("images.remove")}">×</span></div>${
        problem ||
        `<input class="img-note" id="${kind}-note-${i}" type="text" placeholder="${t("images.notePlaceholder")}" value="${esc(img.note)}">`
      }</div>`;
    })
    .join("");
  const full = list.length >= max;
  const busy = state.imagesBusy;
  const add =
    busy || full
      ? `<div class="add off"><span class="muted">${busy ? t("images.checking") : t("images.limit", { n: max })}</span></div>`
      : `<div class="add" data-act="add-${kind}"><span class="plus">+</span><span>${t("images.add")}</span></div>`;
  return `<div class="lbl">${kind === "img" ? t("images.title") : t("own.refs", { n: max })}</div>
  ${cards ? `<div class="tiles">${cards}</div>` : ""}
  ${list.some((i) => i.error) ? `<div class="note warn-text">${t("images.skipped")}</div>` : ""}
  ${add}
  <div class="note muted">${kind === "img" ? t("images.hint") : t("own.refsHint")}</div>`;
}

/** Opens the file picker, then asks the companion for sizes and thumbnails. */
async function addImages(kind: ImageList) {
  const list = imageList(kind);
  const max = kind === "img" ? MAX_IMAGES : MAX_REFS;
  const picked = await host().pickImages(["png", "jpg", "jpeg", "webp"]);
  const known = new Set(list.map((i) => i.path));
  const paths = picked.filter((p) => p && !known.has(p)).slice(0, max - list.length);
  if (!paths.length) return;
  state.imagesBusy = true;
  render();
  try {
    const reply = await session.request<ServerMessage>({ type: "assets.inspect", paths }, "assets");
    for (const card of reply.assets as Omit<PickedImage, "note">[])
      list.push({ ...card, note: "" });
    trace(`images: ${paths.length} added to ${kind}`);
  } catch (err) {
    trace(`images: failed ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    state.imagesBusy = false;
    render();
  }
}

/** The editor's own styles in a row of their own under the presets, so the 4 x 3 grid stays as it is. */
function ownStylesRow(width: number): string {
  const own = state.styles.filter((s) => s.custom);
  if (!own.length) return "";
  return `<div class="lbl">${t("own.mine")}</div><div class="tiles">${own.map((s) => styleTile(s, width)).join("")}</div>`;
}

/** Your Own Style: describe, wait, then review the three preview stills. */
function ownScreen(): string {
  const o = state.own;
  if (!o) return "";
  const close = `<div class="icon" data-act="own-close" title="${t("settings.close")}">×</div>`;
  if (o.stage === "running") {
    const elapsed = Math.round((Date.now() - o.startedAt) / 60000);
    return `${header(t("own.preparing"), "")}
  <div class="box"><div>${esc(o.last)}</div><div class="small muted mt">${elapsed ? t("progress.elapsed", { m: elapsed }) : t("progress.justStarted")}</div></div>
  <div class="bar"><div style="width:${o.last === t("detail.sampleScenes") ? 60 : o.last === t("detail.stills") ? 85 : 25}%"></div></div>`;
  }
  if (o.stage === "review" && o.result) {
    const r = o.result;
    const width = Math.floor((contentWidth() - 2 * 8) / 3);
    const stills = r.stillImages
      .filter((st) => st.image)
      .map((st, i) =>
        imgSlot(
          `own:${r.name}:${i}:${(st.image as string).length}`,
          st.image as string,
          width,
          h169(width),
          `data-act="own-zoom" data-val="${i}"`,
          "still-img",
        ),
      )
      .join('<div style="width:8px"></div>');
    const notes = localized(r.notes);
    return `${header(t("own.review"), close)}
  <div class="rec sel"><div class="rec-text"><div class="rec-name">${esc(localized(r.displayName))}</div></div></div>
  <div class="row mt" style="justify-content:flex-start">${stills}</div>
  ${notes ? `<div class="lbl">${t("own.notes")}</div><div class="box small">${esc(notes)}</div>` : ""}
  ${o.error ? `<div class="box warn">${esc(o.error)}</div>` : ""}
  <div class="btn mt" data-act="own-keep">${t("own.keep")}</div>
  <div class="lbl">${t("own.redo")}</div>
  <textarea id="own-redo" rows="2" placeholder="${t("own.redoPlaceholder")}">${esc(o.redoNote)}</textarea>
  <div class="btn2 mt" data-act="own-redo">${t("own.redo")}</div>
  ${
    o.confirmDelete
      ? `<div class="note warn-text mt">${t("own.deleteAsk")}</div><div class="btn2 mt" data-act="own-delete-yes">${t("own.deleteConfirm")}</div>`
      : `<div class="btn2 mt" data-act="own-delete">${t("own.delete")}</div>`
  }`;
  }
  // always enabled: typing does not re-render, so a disabled button would stay disabled; the action checks
  return `${header(t("own.title"), close)}
  ${o.error ? `<div class="box warn">${esc(o.error)}</div>` : ""}
  <div class="lbl">${t("own.describe")}</div>
  <textarea id="own-desc" rows="4" placeholder="${t("own.describePlaceholder")}">${esc(o.description)}</textarea>
  ${imagesBox("ref")}
  <div class="note muted mt">${t("own.cost")}</div>
  <div class="row small muted mt"><span>${providerLabel()}</span></div>
  <div class="btn" data-act="own-create">${t("own.create")}</div>`;
}

/** Asks the companion for the style cards again, after a style was made or deleted. */
async function refreshStyles() {
  const reply = await session.request<ServerMessage>({ type: "styles.list" }, "styles");
  state.styles = reply.styles as StyleCard[];
}

/** Starts a style job (make, or revise with a note) and follows it until the preview stills arrive. */
async function startStyleJob(params: Record<string, unknown>) {
  const o = state.own;
  if (!o) return;
  o.stage = "running";
  o.error = null;
  o.last = t("detail.styleWriting");
  o.startedAt = Date.now();
  render();
  const off = session.on((m) => {
    if (!state.own || m.jobId !== state.own.jobId) return;
    const own = state.own;
    if (m.type === "job.progress") {
      own.last = detailOf(String(m.message)) ?? own.last;
      trace(`style: ${String(m.message)}`);
    } else if (m.type === "job.done") {
      off();
      own.result = m.result as OwnStyle["result"];
      own.stage = "review";
      own.redoNote = "";
      own.confirmDelete = false;
      trace(`style: done ${own.result?.name}`);
      // the style is saved already; the grid shows it even if the editor closes this screen
      void refreshStyles()
        .then(render)
        .catch((e: unknown) => trace(`styles refresh threw: ${String(e)}`));
    } else if (m.type === "job.error") {
      off();
      own.stage = own.result ? "review" : "new";
      own.error = t("own.failed", { message: jobErrorText(m) });
      trace(`style: failed ${String(m.message)}`);
    } else return;
    render();
  });
  try {
    const accepted = await session.request<ServerMessage>(
      {
        type: "job.start",
        ref: String(Date.now()),
        params: {
          kind: "style",
          ...providerParams(),
          ...params,
        },
      },
      "job.accepted",
    );
    o.jobId = String(accepted.jobId);
  } catch (err) {
    off();
    o.stage = o.result ? "review" : "new";
    o.error = t("own.failed", { message: err instanceof Error ? err.message : String(err) });
    render();
  }
}

/** The story tab: brief, then the narration to edit, a voice, and the new sequence. */
function storyBox(): string {
  const st = state.story;
  const err = st.error ? `<div class="box warn">${esc(st.error)}${reportLink(st.error)}</div>` : "";
  if (st.stage === "writing" || st.stage === "voicing")
    return `${err}<div class="box mt"><div>${esc(st.last)}</div></div><div class="bar"><div style="width:${st.stage === "writing" ? 30 : 70}%"></div></div>`;
  if (st.stage === "done" && st.done)
    return `<div class="box ok mt">${t("story.done", { name: st.done.name, duration: formatDuration(st.done.durationS) })}</div>
  ${st.done.musicNote ? `<div class="box mt">${esc(st.done.musicNote)}</div>` : ""}
  <div class="btn2 mt" data-act="story-new">${t("story.restart")}</div>`;
  if (st.stage === "script") {
    // the narration voices first and the chosen one always; the rest behind All Voices
    const shown = st.allVoices
      ? st.voices
      : st.voices.filter((v) => NARRATION_VOICES.includes(v.name) || v.name === st.voice);
    const voices = shown
      .map(
        (v) =>
          `<div class="vrow${v.name === st.voice ? " on" : ""}"><div class="vname" data-act="story-voice" data-val="${esc(v.name)}">${v.name === st.voice ? "✓ " : ""}${esc(v.name)} <span class="small muted">${esc(voiceCharacter(v.character))}</span></div>${
            state.voicePlaying === v.name
              ? `<div class="link" data-act="story-stop">■ ${t("story.stopShort")}</div>`
              : `<div class="link" data-act="story-listen" data-val="${esc(v.name)}">▶ ${t("story.listenShort")}</div>`
          }</div>`,
      )
      .join("");
    return `${err}
  <div class="lbl">${esc(st.title || t("story.script"))}</div>
  <div class="note muted">${t("story.scriptHint")}</div>
  <textarea id="story-script" rows="12">${esc(st.script)}</textarea>
  <div class="note muted">${t("story.estimate", { duration: formatDuration(storySeconds(st.script, st.language)) })}</div>
  ${
    st.source === "own"
      ? ""
      : `<div class="lbl">${t("story.note")}</div>
  <textarea id="story-note" rows="2" placeholder="${t("story.notePlaceholder")}">${esc(st.note)}</textarea>
  <div class="btn2 mt" data-act="story-rewrite">${t("story.rewrite")}</div>`
  }
  <div class="lbl">${t("story.voice")}</div>
  ${st.keySet ? "" : `<div class="box warn">${t("story.noKey")}</div>`}
  <div class="vlist">${voices}</div>
  <div class="link more" data-act="story-voices-all">${st.allVoices ? t("story.fewerVoices") : t("story.allVoices", { n: st.voices.length })}</div>
  <div class="lbl">${t("home.format")}</div>
  ${seg("story-format", st.format, [
    ["orijinal", t("format.original")],
    ["landscape", t("format.landscape")],
    ["portrait", t("format.portrait")],
    ["square", t("format.square")],
  ])}
  <div class="note muted">${t("story.formatNote")}</div>
  <div class="lbl">${t("story.music")}</div>
  ${seg("story-music", st.music, [
    ["on", t("story.musicOn")],
    ["off", t("story.musicOff")],
  ])}
  ${
    st.music === "on"
      ? `<div class="note muted">${
          state.styles.find((s) => s.name === state.style)
            ? t("story.musicStyle", {
                style: localized(state.styles.find((s) => s.name === state.style)!.displayName),
              })
            : t("story.musicTone")
        }</div>`
      : ""
  }
  <div class="btn mt" data-act="story-make">${t("story.make")}</div>`;
  }
  const source = seg("story-source", st.source, [
    ["write", t("story.sourceWrite")],
    ["own", t("story.sourceOwn")],
  ]);
  if (st.source === "own")
    return `${err}${source}
  <div class="lbl">${t("story.ownLabel")}</div>
  <textarea id="story-own" rows="12" placeholder="${t("story.ownPlaceholder")}">${esc(st.own)}</textarea>
  <div class="note muted" id="story-own-count">${ownCountLine(st.own, st.language)}</div>
  <div class="lbl">${t("story.language")}</div>
  ${seg("story-lang", st.language, [
    ["tr", t("story.lang.tr")],
    ["en", t("story.lang.en")],
  ])}
  <div class="btn mt" data-act="story-own-go">${t("story.ownGo")}</div>`;
  return `${err}${source}
  <div class="lbl">${t("story.brief")}</div>
  <textarea id="story-brief" rows="4" placeholder="${t("story.briefPlaceholder")}">${esc(st.brief)}</textarea>
  <div class="lbl">${t("story.length")}</div>
  ${seg("story-length", st.lengthChoice, [
    ["30", formatDuration(30)],
    ["60", formatDuration(60)],
    ["120", formatDuration(120)],
    ["custom", t("story.lengthCustom")],
  ])}
  ${
    st.lengthChoice === "custom"
      ? `<input class="img-note mt" id="story-length-input" type="text" placeholder="${t("story.lengthPlaceholder")}" value="${esc(st.customLength)}">`
      : ""
  }
  <div class="lbl">${t("story.language")}</div>
  ${seg("story-lang", st.language, [
    ["tr", t("story.lang.tr")],
    ["en", t("story.lang.en")],
  ])}
  <div class="lbl">${t("story.tone")}</div>
  <input class="img-note" id="story-tone" type="text" placeholder="${t("story.tonePlaceholder")}" value="${esc(st.tone)}">
  <div class="row small muted mt"><span>${providerLabel()}</span></div>
  <div class="btn" data-act="story-write">${t("story.write")}</div>`;
}

/** "412 words · about 2:45 when read aloud", and a warning past the story limit. */
function ownCountLine(text: string, language: string): string {
  const sum = ownSummary(text, language);
  if (!sum.words) return "";
  const line = t("story.ownCount", { n: sum.words, duration: formatDuration(sum.seconds) });
  return sum.tooLong
    ? `${line}<div class="warn-text">${t("story.ownTooLong", { max: formatDuration(OWN_MAX_S) })}</div>`
    : line;
}

/** Runs a story job and calls back with its result; progress goes to the story's status line. */
async function storyJob(
  params: Record<string, unknown>,
  onDone: (result: Record<string, unknown>) => void,
) {
  const st = state.story;
  st.error = null;
  const off = session.on((m) => {
    if (m.jobId !== st.jobId) return;
    if (m.type === "job.progress") {
      st.last = detailOf(String(m.message)) ?? st.last;
      trace(`story: ${String(m.message)}`);
      render();
    } else if (m.type === "job.done") {
      off();
      onDone(m.result as Record<string, unknown>);
    } else if (m.type === "job.error") {
      off();
      st.stage = st.script ? "script" : "brief";
      st.error = t("story.failed", { message: jobErrorText(m) });
      trace(`story: failed ${String(m.message)}`);
      render();
    }
  });
  try {
    const accepted = await session.request<ServerMessage>(
      { type: "job.start", ref: String(Date.now()), params },
      "job.accepted",
    );
    st.jobId = String(accepted.jobId);
  } catch (err) {
    off();
    st.stage = st.script ? "script" : "brief";
    st.error = t("story.failed", { message: err instanceof Error ? err.message : String(err) });
    render();
  }
}

async function loadVoices() {
  const reply = await session.request<ServerMessage>({ type: "speech.voices" }, "voices");
  state.story.voices = reply.voices as StoryState["voices"];
  state.story.keySet = Boolean(reply.keySet);
}

function writeStoryJob(revise: boolean) {
  const st = state.story;
  st.stage = "writing";
  st.last = t("story.writing");
  render();
  void storyJob(
    {
      kind: "story-write",
      brief: st.brief.trim(),
      durationS: st.durationS,
      language: st.language,
      ...(st.tone.trim() ? { tone: st.tone.trim() } : {}),
      ...(revise
        ? {
            revise: {
              story: {
                title: st.title,
                voice_style: st.voiceStyle,
                paragraphs: st.script
                  .split(/\n\s*\n/)
                  .map((p) => p.trim())
                  .filter(Boolean),
              },
              note: st.note.trim(),
            },
          }
        : {}),
      ...providerParams(),
    },
    (result) => {
      const story = result.story as { title: string; voice_style: string; paragraphs: string[] };
      st.title = story.title;
      st.voiceStyle = story.voice_style;
      st.script = story.paragraphs.join("\n\n");
      st.note = "";
      st.stage = "script";
      render();
      void loadVoices()
        .then(render)
        .catch((e: unknown) => trace(`voices threw: ${String(e)}`));
    },
  );
}

/** Reads the narration aloud into a job folder, then opens it as a new sequence in Premiere. */
async function makeStorySequence() {
  const st = state.story;
  const target = await readSequence();
  if (!target) return render();
  st.stage = "voicing";
  st.last = t("story.voicing");
  render();
  const name = t("story.sequence", { title: st.title || "Story" }).slice(0, 80);
  try {
    const prepared = await session.request<ServerMessage>(
      {
        type: "job.prepare",
        projectPath: target.projectPath,
        sequenceName: st.title || "Story",
        ...(target.jobRoot ? { jobRoot: target.jobRoot } : {}),
      },
      "job.prepared",
    );
    await storyJob(
      {
        kind: "story-voice",
        title: st.title || "Story",
        text: st.script.trim(),
        voice: st.voice,
        style: st.voiceStyle || undefined,
        outDir: String(prepared.jobDir),
        ...(st.music === "on"
          ? {
              music: {
                ...(state.style ? { style: state.style } : {}),
                subject: st.title || st.brief,
              },
            }
          : {}),
      },
      (result) => {
        st.last = t("story.placing");
        render();
        host()
          .createStorySequence(
            target,
            name,
            String(result.file),
            result.music ? String(result.music) : null,
            st.format === "orijinal" ? undefined : st.format,
          )
          .then(() => {
            st.done = {
              name,
              durationS: Number(result.durationS),
              musicNote: storyMusicNote(result.musicError ? String(result.musicError) : null),
            };
            st.stage = "done";
            trace(`story: sequence ${name}`);
            return readSequence();
          })
          .then((seq) => {
            if (seq) store(`narration:${seq.id}`, String(result.file));
          })
          .then(render)
          .catch((err: unknown) => {
            st.stage = "script";
            st.error = t("story.failed", {
              message: err instanceof Error ? err.message : String(err),
            });
            render();
          });
      },
    );
  } catch (err) {
    st.stage = "script";
    st.error = t("story.failed", { message: err instanceof Error ? err.message : String(err) });
    render();
  }
}

/** The Claude providers share the Claude model setting. */
const CLAUDE_KINDS = new Set(["auto", "claude-code", "anthropic"]);
/** Servers on this computer: no key, their own model list, a model that may think. */
const LOCAL_PROVIDERS = new Set(["lmstudio", "ollama"]);

function providerName(id: string): string {
  if (id === "auto") return t("prov.auto");
  if (id === "claude-code") return t("prov.plan");
  if (id === "codex") return t("prov.chatgptPlan");
  if (id === "grok") return t("prov.grokPlan");
  if (id === "anthropic") return t("prov.claudeApi");
  if (id === "custom") return t("prov.custom");
  if (id === "lmstudio") return t("prov.lmstudio");
  if (id === "ollama") return t("prov.ollama");
  const entry = setup.list.find((p) => p.id === id);
  return entry ? entry.displayName.replace(/\s*\(.*\)$/, "") : id;
}

function modelFor(id: string): string {
  if (CLAUDE_KINDS.has(id)) return state.settings.model;
  // empty: the model set in Codex itself
  if (id === "codex") return state.settings.models.codex ?? "";
  const chosen = state.settings.models[id];
  if (chosen) return chosen;
  if (LOCAL_PROVIDERS.has(id)) return lmStudioDefault(setup.served[id] ?? []);
  return setup.list.find((p) => p.id === id)?.models[0] ?? "";
}

/**
 * What a job sends: the provider, its model and, when the editor typed one, its address; for LM Studio also
 * whether a model that thinks may think.
 */
function providerParams(): {
  provider: string;
  model?: string;
  baseURL?: string;
  thinking?: "off" | "on";
} {
  const id = state.settings.provider;
  const model = modelFor(id);
  const baseURL = state.settings.baseURLs[id]?.trim();
  return {
    provider: id,
    ...(model ? { model } : {}),
    ...(baseURL ? { baseURL } : {}),
    ...(LOCAL_PROVIDERS.has(id) ? { thinking: localThinking(id) } : {}),
  };
}

function localThinking(id: string): "off" | "on" {
  return state.settings.thinking?.[id] ?? "off";
}

const CLAUDE_MODEL_NAMES: Record<string, string> = {
  "claude-fable-5-1": "Fable 5.1",
  "claude-opus-5-5": "Opus 5.5",
  "claude-sonnet-5-5": "Sonnet 5.5",
  "claude-haiku-5-5": "Haiku 5.5",
};

function modelLabel(model: string): string {
  if (model === "") return t("prov.codexDefault");
  if (CLAUDE_MODEL_NAMES[model]) return CLAUDE_MODEL_NAMES[model];
  // a local server's own name for the model (LM Studio: "Qwen3.8 27B" for qwen/qwen3.8-27b)
  for (const list of Object.values(setup.served)) {
    const found = list.find((m) => m.id === model);
    if (found) return found.displayName;
  }
  return prettyModel(model);
}

/** Claude Code reports the plan in lower case ("max"); shown as a name. */
function planName(plan: string | null): string {
  if (!plan) return "Claude";
  return plan.charAt(0).toLocaleUpperCase() + plan.slice(1);
}

/**
 * The line under the button names who will do the work, so a provider left selected from a test is seen
 * before a long, paid job starts (an xAI job ran for half an hour unnoticed, 8 Oct 2026). Automatic says
 * where it goes: the Claude plan when Claude Code is signed in, otherwise the Claude API.
 */
function providerLabel(): string {
  const id = state.settings.provider;
  const model = modelFor(id);
  const cc = setup.claudeCode;
  const plan = cc ? `${t("prov.plan")} (${planName(cc.subscription)})` : t("prov.plan");
  const who =
    id === "auto"
      ? cc
        ? `${t("prov.auto")} · ${cc.installed && cc.loggedIn ? plan : t("prov.claudeApi")}`
        : t("provider.auto")
      : id === "claude-code"
        ? plan
        : providerName(id);
  return model ? `${who} · ${modelLabel(model)}` : who;
}

/** A note above the button when the chosen model was slow in the comparison. */
function slowNote(): string {
  const id = state.settings.provider;
  const slow = setup.list.find((p) => p.id === id)?.slowModels ?? [];
  const model = modelFor(id);
  if (!slow.includes("*") && !slow.includes(model)) return "";
  return `<div class="box warn small">${
    slow.includes("*") ? t("home.slowLocal") : t("home.slowModel", { model: modelLabel(model) })
  }</div>`;
}

function elapsedText(startedAt: number): string {
  const m = Math.round((Date.now() - startedAt) / 60000);
  return m ? t("progress.elapsed", { m }) : t("progress.justStarted");
}

// the elapsed time moves on its own; only its text is touched, a full render could swallow a click
setInterval(() => {
  if (state.screen !== "progress" || !state.job) return;
  const el = document.getElementById("elapsed");
  if (el) el.textContent = elapsedText(state.job.startedAt);
}, 15000);

function progress(): string {
  const job = state.job;
  if (!job) return "";
  const steps = Array.from({ length: STEP_COUNT }, (_, i) => {
    const cls = i < job.step ? "done" : i === job.step ? "now" : "todo";
    const mark = i < job.step ? "✓" : i === job.step ? "●" : "○";
    const text = stepLabel(i, i === job.step);
    return `<div class="step ${cls}"><span class="mark">${mark}</span><span>${text}${
      i === 1 && job.scenes.length && i < job.step
        ? ` · ${t("progress.scenes", { n: job.scenes.length })}`
        : ""
    }</span></div>`;
  }).join("");
  const plan = job.scenes.length
    ? `<div class="lbl">${t("progress.plan")}</div><div class="box small">${job.scenes
        .map((s) => `${sceneName(s.id)} · ${techniqueName(s.technique)}`)
        .join("<br>")}</div>`
    : "";
  return `${header(t("progress.title"), `${partTag()}<span class="muted">${Math.min(job.step + 1, STEP_COUNT)} / ${STEP_COUNT}</span>`)}
  <div class="box">${steps}</div>
  <div class="bar"><div style="width:${Math.round(((job.step + (job.sub ?? 0)) / STEP_COUNT) * 100)}%"></div></div>
  <div class="row small muted"><span id="elapsed">${elapsedText(job.startedAt)}</span><span>${esc(job.last)}</span></div>
  ${plan}
  ${
    job.confirmStop
      ? `<div class="box warn small mt">${t("progress.stopAsk")}</div>
  <div class="row2 mt"><div class="btn2 stop" data-act="stop-yes">${t("progress.stopYes")}</div><div class="btn2" data-act="stop-no">${t("progress.stopNo")}</div></div>`
      : `<div class="row2 mt"><div class="btn2" data-act="home">${t("progress.background")}</div><div class="btn2 stop" data-act="stop">${t("progress.stop")}</div></div>`
  }`;
}

interface ProviderEntry {
  id: string;
  displayName: string;
  models: string[];
  tier: "recommended" | "works" | "experimental";
  needsKey: boolean;
  keySet: boolean;
  requires: string[];
  baseURL: string | null;
  perModelVision: boolean;
  keyUrl: string | null;
  /** Models measured as slow ("*": every model, a local one); the panel warns before a job. */
  slowModels?: string[];
}

interface ProviderTest {
  ok: boolean;
  vision: boolean;
  model: string;
  ms: number;
  message?: string;
}

/** The settings screen's provider state, loaded from the companion when the screen opens. */
const setup = {
  list: [] as ProviderEntry[],
  claudeCode: null as null | {
    installed: boolean;
    loggedIn: boolean;
    version: string | null;
    subscription: string | null;
  },
  codex: null as null | {
    installed: boolean;
    loggedIn: boolean;
    version: string | null;
    method: "chatgpt" | "api_key" | null;
  },
  grok: null as null | { installed: boolean; loggedIn: boolean; version: string | null },
  /** Whether a newer agent CLI is out: { current, latest, available } per agent. */
  updates: {} as Record<
    string,
    { current: string | null; latest: string | null; available: boolean }
  >,
  /** An agent being updated in a terminal; the panel looks until its version changes. */
  updating: null as string | null,
  /** The agent whose install command was just copied, so its button says so. */
  copied: null as string | null,
  /** An agent whose sign-in is open in a terminal; the panel looks until it is signed in. */
  signingIn: null as string | null,
  /** An agent whose sign-out the editor is asked to confirm, or that is signing out now. */
  confirmLogout: null as string | null,
  signingOut: null as string | null,
  /** Models a local server reported (LM Studio), with whether they read images. */
  served: {} as Record<string, ServedModel[]>,
  servedError: {} as Record<string, string>,
  editingKey: null as string | null,
  keyDraft: "",
  confirmDelete: null as string | null,
  test: null as null | { provider: string; running: boolean; result: ProviderTest | null },
  error: null as string | null,
};

async function refreshProviders() {
  try {
    const r = await session.request<ServerMessage>({ type: "providers.list" }, "providers", 30_000);
    setup.list = r.providers as ProviderEntry[];
    setup.claudeCode = r.claudeCode as typeof setup.claudeCode;
    setup.codex = r.codex as typeof setup.codex;
    setup.grok = r.grok as typeof setup.grok;
    setup.updates = (r.updates ?? {}) as typeof setup.updates;
    const custom = await session.request<ServerMessage>(
      { type: "keys.has", provider: "custom" },
      "keys.has",
    );
    customKey = Boolean(custom.present);
  } catch (err) {
    // not connected: the settings show the app's own box instead (its text follows the panel language)
    if (state.conn === "ok") setup.error = err instanceof Error ? err.message : String(err);
  }
  render();
}

async function loadServed(id: string) {
  try {
    const r = await session.request<ServerMessage>(
      { type: "models.list", provider: id },
      "models",
      30_000,
    );
    setup.served[id] = r.models as (typeof setup.served)[string];
    delete setup.servedError[id];
  } catch (err) {
    setup.servedError[id] = err instanceof Error ? err.message : String(err);
  }
  render();
}

function tierTag(tier: ProviderEntry["tier"] | null): string {
  // "works" is the normal case and needs no label; only Recommended (and Experimental, if ever) shows
  if (!tier || tier === "works") return `<span class="ptag none"></span>`;
  const label = tier === "recommended" ? t("tier.recommended") : t("tier.experimental");
  return `<span class="ptag ${tier}">${label}</span>`;
}

function keyStatus(entry: ProviderEntry | undefined, id: string): string {
  if (id === "claude-code" || id === "codex" || id === "grok") {
    const a = agentState(id);
    if (!a) return `<span class="pkey"></span>`;
    if (a.installed && setup.updates[id]?.available)
      return `<span class="pkey upd">↑ ${t("prov.updateShort")}</span>`;
    return a.loggedIn
      ? `<span class="pkey set">● ${t("prov.signedIn")}</span>`
      : `<span class="pkey">${a.installed ? t("prov.signedOut") : t("prov.notInstalled")}</span>`;
  }
  const needs = id === "custom" || (entry?.needsKey ?? false);
  if (!needs) return `<span class="pkey"></span>`;
  const set = id === "custom" ? customKeySet() : entry?.keySet;
  return set
    ? `<span class="pkey set">● ${t("prov.keySaved")}</span>`
    : `<span class="pkey">${t("prov.noKey")}</span>`;
}

/** The sign-in state of an agent CLI (Claude Code, Codex, Grok). */
function agentState(id: string): { installed: boolean; loggedIn: boolean } | null {
  return id === "claude-code"
    ? setup.claudeCode
    : id === "codex"
      ? setup.codex
      : id === "grok"
        ? setup.grok
        : null;
}

/** Whether a key is saved for the custom endpoint; it is not one of the presets. */
let customKey = false;
function customKeySet(): boolean {
  return customKey;
}

function testLine(id: string): string {
  const tst = setup.test;
  if (!tst || tst.provider !== id) return "";
  if (tst.running) return `<div class="ptest muted">${t("prov.testing")}</div>`;
  const r = tst.result;
  if (!r) return "";
  if (r.ok && r.vision)
    return `<div class="ptest ok-text">✓ ${t("prov.testOk", { s: (r.ms / 1000).toFixed(1).replace(".", lang() === "tr" ? "," : ".") })}</div>`;
  if (r.ok) return `<div class="ptest warn-text">${t("prov.testNoVision")}</div>`;
  return `<div class="ptest warn-text">${esc(r.message ?? t("prov.testFailed"))}</div>`;
}

/** The key part of a provider's details: the stored key, or a field to enter one. */
function keyBlock(id: string, entry: ProviderEntry | undefined, withTest: boolean): string {
  const set = id === "custom" ? customKeySet() : (entry?.keySet ?? false);
  const link = entry?.keyUrl
    ? `<span class="link" data-act="open-url" data-val="${esc(entry.keyUrl)}">${t("prov.getKey")} ↗</span>`
    : "";
  const head = `<div class="row small"><span>${t("prov.apiKey")}</span>${link}</div>`;
  const test = withTest
    ? `<div class="pbtn primary" data-act="prov-test" data-val="${esc(id)}">${t("prov.test")}</div>`
    : "";
  if (set && setup.editingKey !== id) {
    const del =
      setup.confirmDelete === id
        ? `<div class="pbtn" data-act="key-delete-yes" data-val="${esc(id)}">${t("prov.deleteYes")}</div><div class="pbtn" data-act="key-delete-no">${t("prov.deleteNo")}</div>`
        : `<div class="pbtn" data-act="key-edit" data-val="${esc(id)}">${t("prov.change")}</div><div class="pbtn" data-act="key-delete" data-val="${esc(id)}">${t("prov.delete")}</div>`;
    return `${head}<div class="pfield muted">•••••••••••• ${t("prov.keySaved")}</div>
    ${setup.confirmDelete === id ? `<div class="note warn-text">${t("prov.deleteAsk")}</div>` : ""}
    <div class="pbtns">${del}${setup.confirmDelete === id ? "" : test}</div>`;
  }
  return `${head}<input class="img-note" id="key-input" type="password" placeholder="${t("prov.keyPlaceholder")}">
  <div class="pbtns"><div class="pbtn primary" data-act="key-save" data-val="${esc(id)}">${t("prov.save")}</div>${
    setup.editingKey === id
      ? `<div class="pbtn" data-act="key-cancel">${t("prov.cancel")}</div>`
      : ""
  }</div>`;
}

/** The chosen provider's details, under its row. */
function providerDetail(id: string): string {
  const entry = setup.list.find((p) => p.id === id);
  const cc = setup.claudeCode;
  let body: string;
  if (id === "auto") {
    const anthropicKey = setup.list.find((p) => p.id === "anthropic")?.keySet;
    const now = cc?.loggedIn
      ? `<div class="ptest ok-text">${t("prov.nowPlan", { plan: planName(cc.subscription) })}</div>`
      : anthropicKey
        ? `<div class="ptest ok-text">${t("prov.nowKey")}</div>`
        : `<div class="ptest warn-text">${t("prov.nowNothing")}</div>`;
    body = `<div class="small">${t("prov.autoNote")}</div>${now}`;
  } else if (id === "claude-code" || id === "codex" || id === "grok") {
    const a = agentState(id);
    const install =
      id === "claude-code"
        ? "https://code.claude.com/docs/en/quickstart"
        : id === "codex"
          ? "https://learn.chatgpt.com/docs/codex/cli"
          : "https://docs.x.ai/build/overview";
    const okLine =
      id === "claude-code"
        ? t("prov.planOk", { plan: planName(cc?.subscription ?? null), version: cc?.version ?? "" })
        : id === "codex"
          ? t("prov.codexOk", {
              method: setup.codex?.method === "api_key" ? t("prov.codexKey") : "ChatGPT",
              version: setup.codex?.version ?? "",
            })
          : t("prov.grokOk", { version: setup.grok?.version ?? "" });
    body = `<div class="small">${id === "claude-code" ? t("prov.planNote") : id === "codex" ? t("prov.codexNote") : t("prov.grokNote")}</div>`;
    const upd = setup.updates[id];
    if (a?.installed && upd?.available)
      body +=
        setup.updating === id
          ? `<div class="ptest muted">${t("prov.updating")}</div>`
          : `<div class="ptest warn-text">${t("prov.updateAvailable", { latest: upd.latest ?? "", current: upd.current ?? "" })}</div><div class="pbtns"><div class="pbtn primary" data-act="agent-update" data-val="${id}">${t("prov.update")}</div></div><div class="note muted">${t("prov.orRun", { command: id === "claude-code" ? "claude update" : id === "codex" ? "codex update" : "grok update" })}</div>`;
    if (!a?.installed)
      body += `<div class="ptest warn-text">${t("prov.agentMissing")}</div>${agentInstallHelp(id)}<div class="pbtns"><div class="pbtn primary" data-act="open-url" data-val="${install}">${t("prov.howInstall")} ↗</div><div class="pbtn" data-act="agent-recheck">${t("prov.recheck")}</div></div>`;
    else if (!a.loggedIn)
      body +=
        setup.signingIn === id
          ? `<div class="ptest muted">${t("prov.signingIn")}</div>`
          : `<div class="ptest warn-text">${t("prov.agentSignedOut")}</div><div class="pbtns"><div class="pbtn primary" data-act="agent-login" data-val="${id}">${t("prov.signIn")}</div><div class="pbtn" data-act="agent-recheck">${t("prov.recheck")}</div></div><div class="note muted">${t(
              "prov.orRun",
              {
                command:
                  id === "claude-code"
                    ? "claude auth login"
                    : id === "codex"
                      ? "codex login"
                      : "grok login --oauth",
              },
            )}</div>`;
    else if (setup.signingOut === id)
      body += `<div class="ptest muted">${t("prov.signingOut")}</div>`;
    else if (setup.confirmLogout === id)
      body += `<div class="ptest ok-text">${okLine}</div><div class="note warn-text">${t("prov.signOutAsk", { name: agentName(id) })}</div><div class="pbtns"><div class="pbtn" data-act="agent-logout-yes" data-val="${id}">${t("prov.signOutYes")}</div><div class="pbtn" data-act="agent-logout-no">${t("prov.deleteNo")}</div></div>`;
    else {
      const signOut = `<div class="pbtn" data-act="agent-logout" data-val="${id}">${t("prov.signOut")}</div>`;
      body +=
        id === "grok"
          ? // its image reading could not be checked yet (only models that read images)
            `<div class="ptest ok-text">${okLine}</div><div class="note warn-text">${t("prov.grokUnverified")}</div><div class="pbtns">${signOut}</div>`
          : `<div class="ptest ok-text">${okLine}</div><div class="pbtns"><div class="pbtn primary" data-act="prov-test" data-val="${id}">${t("prov.test")}</div>${signOut}</div>`;
    }
  } else if (LOCAL_PROVIDERS.has(id)) {
    body = `<div class="small">${t(id === "ollama" ? "prov.ollamaNote" : "prov.localNote")}</div>
    <div class="pbtns"><div class="pbtn primary" data-act="prov-test" data-val="${id}">${t("prov.test")}</div></div>`;
  } else {
    const needsAddress = id === "custom" || (entry?.requires.length ?? 0) > 0;
    const address = needsAddress
      ? `<div class="small mt">${t("prov.address")}</div><input class="img-note" id="base-input" type="text" placeholder="${esc(entry?.baseURL ?? "https://…/v1")}" value="${esc(state.settings.baseURLs[id] ?? "")}">`
      : "";
    const model =
      id === "custom"
        ? `<div class="small mt">${t("prov.modelName")}</div><input class="img-note" id="model-input" type="text" placeholder="${t("prov.modelPlaceholder")}" value="${esc(state.settings.models.custom ?? "")}">`
        : "";
    body = `${keyBlock(id, entry, true)}${address}${model}<div class="note muted">${t("prov.keyStored")}${id === "gemini" ? ` ${t("prov.geminiShared")}` : ""}</div>`;
  }
  return `<div class="pdetail">${body}${testLine(id)}</div>`;
}

function providerList(compact = false): string {
  const all = ["auto", "claude-code", "codex", "grok", ...setup.list.map((p) => p.id), "custom"];
  // the setup guide shows the usual choices and the chosen one; the rest behind Others
  const few = ["auto", "claude-code", "codex", "anthropic", state.settings.provider];
  const ids = compact && !onboard.allProviders ? all.filter((id) => few.includes(id)) : all;
  return `<div class="plist">${ids
    .map((id) => {
      const entry = setup.list.find((p) => p.id === id);
      const on = state.settings.provider === id;
      // Claude and GPT 6 Astra did best in the comparison; the rest carry no tag
      const tier =
        id === "auto" || id === "claude-code" || id === "codex"
          ? "recommended"
          : id === "grok" || id === "custom"
            ? null
            : (entry?.tier ?? null);
      return `<div class="prow${on ? " on" : ""}" data-act="provider" data-val="${esc(id)}"><span class="pdot"></span><span class="pname">${esc(providerName(id))}</span>${tierTag(tier)}${keyStatus(entry, id)}</div>${on ? providerDetail(id) : ""}`;
    })
    .join("")}${
    compact && !onboard.allProviders
      ? `<div class="prow" data-act="setup-more"><span class="pdot"></span><span class="pname muted">${t("setup.others")}</span></div>`
      : ""
  }</div>`;
}

function modelList(): string {
  const id = state.settings.provider;
  if (id === "custom") return "";
  const entry = setup.list.find((p) => p.id === id);
  let options: [string, string][];
  let note = "";
  if (CLAUDE_KINDS.has(id))
    options = [
      ["claude-opus-5-5", t("settings.opusNote")],
      ["claude-fable-5-1", t("settings.fableNote")],
      ["claude-sonnet-5-5", t("settings.sonnetNote")],
    ];
  else if (id === "codex")
    options = [
      ["", t("prov.codexDefaultNote")],
      ...(setup.list.find((p) => p.id === "openai")?.models ?? []).map(
        (m) => [m, ""] as [string, string],
      ),
    ];
  else if (id === "openrouter") {
    // the suggested models first; every other model that reads images behind All Models
    const seeing = (setup.served.openrouter ?? []).filter((m) => m.vision);
    const suggested = entry?.models ?? [];
    const rest = onboard.allModels
      ? seeing
          .filter((m) => !suggested.includes(m.id))
          .sort((a, b) => a.displayName.localeCompare(b.displayName))
      : [];
    const info = (m: { contextWindow: number | null } | undefined) =>
      m?.contextWindow ? `${Math.round(m.contextWindow / 1000)}K` : "";
    options = [
      ...suggested.map((m) => [m, info(seeing.find((x) => x.id === m))] as [string, string]),
      ...rest.map((m) => [m.id, info(m)] as [string, string]),
    ];
    if (!suggested.includes(modelFor(id)) && !rest.some((m) => m.id === modelFor(id)))
      options.unshift([modelFor(id), ""]);
    note = setup.servedError.openrouter
      ? `<div class="note warn-text">${esc(setup.servedError.openrouter)}</div>`
      : `<div class="link more" data-act="or-all">${onboard.allModels ? t("prov.fewerModels") : t("prov.allModels", { n: seeing.length })}</div><div class="note muted">${t("prov.openrouterNote")}</div>`;
  } else if (LOCAL_PROVIDERS.has(id)) {
    const served = setup.served[id] ?? [];
    const rows = lmStudioRows(served, t("prov.lmLoaded"));
    options = rows.map((r) => [r.id, r.info]);
    const hidden = served.length - rows.length;
    note = setup.servedError[id]
      ? `<div class="note warn-text">${esc(setup.servedError[id])}</div>`
      : !served.length
        ? `<div class="note muted">${t(id === "ollama" ? "prov.ollamaNone" : "prov.lmNone")}</div>`
        : hidden
          ? `<div class="note muted">${t("prov.lmHidden", { n: hidden })}</div>`
          : "";
    if (rows.some((r) => !r.loaded))
      note += `<div class="note muted">${t(id === "ollama" ? "prov.ollamaLoadsOnChoice" : "prov.lmLoadsOnChoice")}</div>`;
    note += `<div class="note muted">${t("prov.localLimits")}</div>`;
    // only a model whose thinking LM Studio can turn off
    if (served.find((m) => m.id === modelFor(id))?.reasons)
      note += `<div class="lbl">${t("prov.thinking")}</div>${seg("lm-thinking", localThinking(id), [
        ["off", t("prov.thinkingOff")],
        ["on", t("prov.thinkingOn")],
      ])}<div class="note muted">${t("prov.thinkingNote")}</div>`;
  } else options = (entry?.models ?? []).map((m) => [m, ""]);
  const current = modelFor(id);
  const rows = options
    .map(
      ([m, info]) =>
        `<div class="mrow${m === current ? " on" : ""}" data-act="pmodel" data-val="${esc(m)}"><span class="mname">${m === current ? "✓ " : ""}${esc(modelLabel(m))}</span><span class="small muted">${esc(info)}</span></div>`,
    )
    .join("");
  const experimental =
    entry?.tier === "experimental" || id === "codex"
      ? `<div class="note muted">${t("prov.experimentalNote")}</div>`
      : "";
  return `<div class="lbl">${t("settings.model")}</div><div class="mlist">${rows}</div>${note}${experimental}`;
}

/** Story mode's voice and music key, shown even when another provider writes the text. */
function speechKeys(): string {
  const gemini = setup.list.find((p) => p.id === "gemini");
  let body: string;
  if (state.settings.provider === "gemini")
    body = `<div class="small">${t("prov.speechSame")}</div>`;
  else if (gemini?.keySet && setup.editingKey !== "gemini-speech")
    body = `<div class="small">Google Gemini <span class="pkey set">● ${t("prov.keySaved")}</span></div>`;
  else body = keyBlock("gemini", gemini, false);
  return `<div class="lbl">${t("prov.speech")}</div>${body}<div class="note muted">${t("prov.speechNote")}</div>`;
}

/** The first-run guide: companion, computer, speech model, AI, narration and a first try. */
const onboard = {
  /** Steps the editor passed with Continue or Skip. */
  passed: new Set<number>(),
  download: { running: false, pct: 0, error: null as string | null, done: false },
  allProviders: false,
  /** OpenRouter's full list of models that read images is open. */
  allModels: false,
};

type StepState = "done" | "now" | "todo" | "warn";

function speechModelReady(): boolean {
  return onboard.download.done || Boolean(state.system?.speechModel?.cached);
}

/** Each step's state and the line beside its name. */
function setupSteps(): { name: string; state: StepState; status: string }[] {
  const gpuOk = state.system?.gpu?.mode === "hardware";
  const wavOk = wavPresetOk();
  const gemini = setup.list.find((p) => p.id === "gemini");
  const raw: { name: string; done: boolean; warn: boolean; status: string }[] = [
    {
      name: t("setup.companion"),
      done: state.conn === "ok",
      warn: state.conn === "down",
      status:
        state.conn === "ok"
          ? t("settings.running")
          : state.conn === "down"
            ? t("settings.notConnected")
            : t("conn.connecting"),
    },
    {
      name: t("setup.computer"),
      done: Boolean(state.system) && gpuOk && wavOk,
      warn: Boolean(state.system) && (!gpuOk || !wavOk),
      status: !state.system
        ? t("setup.checking")
        : [
            gpuOk ? t("setup.gpuOk") : t("setup.gpuSoft"),
            wavOk ? t("setup.wavOk") : t("setup.wavMissing"),
          ].join(" · "),
    },
    {
      name: t("setup.speechModel"),
      done: speechModelReady(),
      warn: Boolean(onboard.download.error),
      status: speechModelReady()
        ? t("setup.downloaded")
        : onboard.download.running
          ? t("setup.downloading")
          : t("setup.needed"),
    },
    { name: t("setup.ai"), done: onboard.passed.has(3), warn: false, status: providerLabel() },
    {
      name: t("prov.speech"),
      done: onboard.passed.has(4) || Boolean(gemini?.keySet),
      warn: false,
      status: gemini?.keySet ? t("setup.geminiSaved") : t("setup.optional"),
    },
    { name: t("setup.firstTry"), done: false, warn: false, status: t("setup.firstTryTime") },
  ];
  // the first step that is not done (a warning does not stop the guide) is the current one
  const current = raw.findIndex((r, i) => !r.done && !r.warn && !onboard.passed.has(i));
  return raw.map((r, i) => ({
    name: r.name,
    status: r.status,
    state: r.done ? "done" : r.warn ? "warn" : i === current ? "now" : "todo",
  }));
}

function setupBody(i: number, st: StepState): string {
  if (i === 0)
    return state.opening
      ? `<div class="small muted">${t("conn.opening")}</div>`
      : st === "warn"
        ? `<div class="small warn-text">${t("setup.companionDown")}</div><div class="pbtns"><div class="pbtn primary" data-act="open-app">${t("conn.openApp")}</div><div class="pbtn" data-act="reconnect">${t("conn.retry")}</div></div>`
        : "";
  if (i === 1) {
    if (st !== "warn") return "";
    const lines = [
      state.system?.gpu?.mode !== "hardware" ? t("setup.gpuHelp") : "",
      !wavPresetOk() ? t("home.noWavPreset") : "",
    ].filter(Boolean);
    return `<div class="small warn-text">${lines.join(" ")}</div>`;
  }
  if (i === 2) {
    const d = onboard.download;
    if (st === "warn")
      return `<div class="small warn-text">${esc(d.error ?? "")}</div><div class="pbtns"><div class="pbtn primary" data-act="setup-download">${t("setup.tryAgain")}</div></div>`;
    if (st !== "now") return "";
    return `<div class="small">${t("setup.speechNote")}</div>${
      d.running
        ? `<div class="bar"><div style="width:${d.pct}%"></div></div><div class="small muted">%${d.pct} · ${esc(state.system?.speechModel?.name ?? "")}</div>`
        : `<div class="pbtns"><div class="pbtn primary" data-act="setup-download">${t("setup.download")}</div></div>`
    }`;
  }
  if (i === 3)
    return st === "now"
      ? `${providerList(true)}${modelList()}<div class="pbtns"><div class="pbtn primary" data-act="setup-pass" data-val="3">${t("setup.continue")}</div></div>`
      : "";
  if (i === 4)
    return st === "now"
      ? `<div class="small">${t("prov.speechNote")}</div>${keyBlock(
          "gemini",
          setup.list.find((p) => p.id === "gemini"),
          false,
        )}<div class="pbtns"><div class="pbtn" data-act="setup-pass" data-val="4">${t("setup.skip")}</div></div>`
      : "";
  if (i === 5)
    return st === "now"
      ? `<div class="small">${t("setup.firstTryNote")}</div><div class="pbtns"><div class="pbtn primary" data-act="setup-story">${t("setup.tryStory")}</div><div class="pbtn" data-act="setup-range">${t("setup.tryRange")}</div></div>`
      : "";
  return "";
}

function setupScreen(): string {
  const steps = setupSteps();
  const marks: Record<StepState, string> = { done: "✓", warn: "!", now: "", todo: "" };
  const rows = steps
    .map(
      (st, i) =>
        `<div class="ostep ${st.state}"><div class="otop"><span class="omark ${st.state}">${marks[st.state] || i + 1}</span><span class="oname">${esc(st.name)}</span><span class="ostatus">${esc(st.status)}</span></div>${
          st.state === "now" || st.state === "warn"
            ? `<div class="obody">${setupBody(i, st.state)}</div>`
            : ""
        }</div>`,
    )
    .join("");
  const allDone = steps.slice(0, 5).every((st) => st.state === "done" || st.state === "warn");
  return `<div class="hello">${allDone ? t("setup.almost") : t("setup.welcome")}</div>
  <div class="small muted">${t("setup.intro")}</div>
  ${rows}
  <div class="row mt"><span class="link" data-act="setup-finish">${t("setup.skipGuide")}</span><span class="small muted">${t("setup.reopen")}</span></div>`;
}

/** Downloads and loads the speech model (and the screenshot reading data) with a progress bar. */
async function downloadModels() {
  const d = onboard.download;
  if (d.running) return;
  d.running = true;
  d.error = null;
  render();
  let off = () => {};
  try {
    await new Promise<void>((resolve, reject) => {
      off = session.on((m) => {
        if (m.type === "models.progress") {
          const pct = /(\d+)%/.exec(String(m.message))?.[1];
          if (pct) d.pct = Number(pct);
          render();
        } else if (m.type === "models.ready") resolve();
        else if (m.type === "models.failed")
          reject(new Error(t("setup.downloadFailed", { message: String(m.message) })));
      });
      session.send({ type: "models.prepare" });
    });
    d.done = true;
    d.error = null;
    trace("setup: speech model ready");
  } catch (err) {
    d.error = err instanceof Error ? err.message : String(err);
  } finally {
    off();
    d.running = false;
    render();
  }
}

function openSetup() {
  state.screen = "setup";
  void refreshProviders();
  if (state.conn === "ok" && state.system && !speechModelReady()) void downloadModels();
}

function finishSetup() {
  store("onboarded", "1");
  state.screen = "home";
}

function settings(): string {
  const s = state.settings;
  const gpu = state.system?.gpu;
  const okWarn = (ok: boolean) => (ok ? "ok-text" : "warn-text");
  return `${header(t("settings.title"), `<div class="icon" data-act="home" title="${t("settings.close")}">×</div>`)}
  <div class="lbl">${t("settings.language")}</div>
  ${seg("lang", s.lang, [
    ["auto", t("settings.langAuto")],
    ["en", "English"],
    ["tr", "Türkçe"],
  ])}
  <div class="lbl">${t("settings.ai")}</div>
  ${state.conn === "down" || state.opening ? downBox() : setup.error ? `<div class="box warn">${esc(setup.error)}</div>` : ""}
  ${providerList()}
  ${modelList()}
  <div class="lbl">${t("settings.review")}</div>
  ${seg("review", s.review, [
    ["on", t("settings.reviewOn")],
    ["off", t("settings.reviewOff")],
  ])}
  ${speechKeys()}
  <div class="lbl">${t("settings.musicLevel")}</div>
  ${seg(
    "music-level",
    String(s.musicLevel ?? -21),
    ["-27", "-24", "-21", "-18", "-15"].map((v) => [v, `${v} dB`] as [string, string]),
  )}
  ${
    host().onTop
      ? `<div class="lbl">${t("settings.window")}</div>
  ${seg("ontop", host().onTop?.get() ? "on" : "off", [
    ["on", t("settings.onTopOn")],
    ["off", t("settings.onTopOff")],
  ])}`
      : ""
  }
  <div class="lbl">${t("settings.system")}</div>
  <div class="box small">
    <div class="row"><span>${t("settings.companion")}</span><span class="${okWarn(state.conn === "ok")}">${state.conn === "ok" ? t("settings.running") : t("settings.notConnected")}</span></div>
    <div class="row"><span>${t("settings.gpu")}</span><span class="${okWarn(gpu?.mode === "hardware")}">${gpu?.mode === "hardware" ? t("settings.hardware") : esc(gpu?.mode ?? t("settings.unknown"))}</span></div>
    ${host().kind === "premiere" ? `<div class="row"><span>${t("settings.wav")}</span><span class="${okWarn(!!state.system?.wavPreset)}">${state.system?.wavPreset ? t("settings.found") : t("settings.notFound")}</span></div>` : ""}
  </div>
  <div class="link mt" data-act="setup-open">${t("setup.reopenLink")}</div>
  ${versionLine()}
  <div class="btn mt" data-act="home">${t("settings.close")}</div>`;
}

/**
 * The editor left the review without rendering: the companion stops counting it as work in progress, so
 * quitting Kilnframe no longer waits for it. A series' parts are all let go.
 */
function leaveReview() {
  const r = state.review;
  const outDir = r && !r.series ? (r.params.outDir as string | undefined) : undefined;
  if (state.conn === "ok")
    session.send(outDir ? { type: "review.closed", outDir } : { type: "review.closed" });
}

/** The panel's version: what the installed manifest says, else the one it was built with. */
function panelVersion(): string {
  try {
    const v = host().pluginVersion();
    if (v) return v;
  } catch {
    // the browser demo has no uxp module
  }
  return __PANEL_VERSION__;
}

/** The versions, the editor and the panel's language, for the feedback page. */
function mailAbout() {
  return {
    app: state.appVersion ?? t("settings.unknown"),
    panel: panelVersion(),
    editor: editorText({
      premiere: "Premiere",
      resolve: "DaVinci Resolve",
      filmcraft: "FilmCraft",
    } as const),
    os: host().platform(),
    lang: lang(),
    ai: reportProvider(),
  };
}

/**
 * The provider and the model's own id for a report, so a failure can be read ("the scene came out empty" on
 * a small local model is a different case than on Opus). A custom endpoint is named as such, never its address.
 */
function reportProvider(): string {
  const id = state.settings.provider;
  const model = modelFor(id);
  return model ? `${providerName(id)} · ${model}` : providerName(id);
}

/** "Report This Error ↗": the site's feedback page opens with the error and the versions filled in. */
function reportLink(error: string): string {
  // the messages with a number in them are written out with it, as the panel shows them
  const own = NOT_REPORTED.map((k) =>
    t(k, { version: MIN_PREMIERE, max: formatDuration(OWN_MAX_S) }),
  );
  if (!shouldReport(error, own)) return "";
  const url = feedbackPage({ kind: "error", error, ...mailAbout() });
  return `<div class="link mt" data-act="open-url" data-val="${esc(url)}">${t("feedback.report")} ↗</div>`;
}

/** "Kilnframe 0.1.2 · Panel 0.1.2 · Release Notes ↗"; when they differ, how to put the panel right. */
function versionLine(): string {
  const panel = panelVersion();
  const app = state.appVersion;
  const differ = Boolean(app && app !== panel);
  const notes =
    lang() === "tr" ? "https://kilnframe.com/tr/changelog/" : "https://kilnframe.com/changelog/";
  return `<div class="small mt ${differ ? "warn-text" : "muted"}">Kilnframe ${esc(app ?? t("settings.unknown"))} · ${t("settings.panel")} ${esc(panel)} · <span class="link" data-act="open-url" data-val="${notes}">${t("settings.releaseNotes")} ↗</span></div><div class="small mt"><span class="link" data-act="open-url" data-val="${esc(feedbackPage({ kind: "feedback", ...mailAbout() }))}">${t("feedback.send")} ↗</span></div>${
    differ
      ? `<div class="small warn-text">${t(editorText({ premiere: "settings.versionsDiffer", resolve: "settings.versionsDifferResolve", filmcraft: "settings.versionsDifferFilmcraft" }))}</div>`
      : ""
  }`;
}

/** "Redo Scene 3", or "Part 2 · Redo Scene 3" in a series review. */
function redoLabel(key: string): string {
  const [a, b] = key.split(":");
  return b
    ? `${t("parts.short", { i: Number(a) + 1 })} · ${redoSceneLabel(b)}`
    : redoSceneLabel(key);
}

function reviewScreen(): string {
  const r = state.review;
  if (!r) return "";
  const width = 150;
  const height = Math.round(width / r.aspect);
  const tile = (st: StillImage) => {
    const redo = r.redo === st.sceneId;
    const label = sceneName(st.sceneId.split(":").at(-1) ?? st.sceneId);
    return `<div class="still${redo ? " redo" : ""}">${
      st.image
        ? imgSlot(
            `still:${st.sceneId}`,
            st.image,
            width,
            height,
            `data-act="zoom" data-val="${st.sceneId}"`,
            "still-img",
          )
        : `<div class="still-empty" style="width:${width}px;height:${height}px"></div>`
    }<div class="small still-label ${redo ? "warn-text" : ""}" data-act="redo" data-val="${st.sceneId}">${label} ${redo ? t("review.redoMark") : "✓"}</div>${
      st.edgeCut ? `<div class="small warn-text">${t("review.edgeCut")}</div>` : ""
    }</div>`;
  };
  let body: string;
  if (r.series) {
    // grouped by part, in order
    const groups = new Map<string, StillImage[]>();
    for (const st of r.stills) {
      const key = st.sceneId.split(":")[0] ?? "0";
      groups.set(key, [...(groups.get(key) ?? []), st]);
    }
    body = [...groups.entries()]
      .map(
        ([part, list]) =>
          `<div class="lbl">${t("parts.short", { i: Number(part) + 1 })} · ${t("review.scenes", { n: list.length })}</div><div class="stills">${list.map(tile).join("")}</div>`,
      )
      .join("");
  } else body = `<div class="stills">${r.stills.map(tile).join("")}</div>`;
  const redo = r.redo;
  const count = r.series
    ? t("series.partsCount", { n: new Set(r.stills.map((st) => st.sceneId.split(":")[0])).size })
    : t("review.scenes", { n: r.stills.length });
  return `${header(t("review.title"), `<span class="tag2">${count}</span>`)}
  ${body}
  ${r.stills.some((st) => st.edgeCut) ? `<div class="note warn-text">${t("review.edgeCutHint")}</div>` : ""}
  <div class="note muted">${t("review.hint")}</div>
  ${
    redo
      ? `<div class="lbl">${t("review.noteFor", { scene: stillName(redo) })}</div>
  <textarea id="scenenote" rows="2" placeholder="${t("review.notePlaceholder")}">${esc(r.note)}</textarea>
  <div class="note muted">${t("review.onlyThis", { scene: stillName(redo) })}</div>`
      : ""
  }
  <div class="btn" data-act="approve">${r.series ? t("series.approveAll") : t("review.approve")}</div>
  ${redo ? `<div class="btn2 mt" data-act="recompose">${redoLabel(redo)}</div>` : ""}
  ${r.series ? `<div class="btn2 mt" data-act="series-later">${t("series.later")}</div>` : ""}
  <div class="btn2 mt" data-act="cancel-review">${t("review.cancel")}</div>
  <div class="note muted">${r.series ? t("review.cancelParts") : t("review.cancelNote")}</div>`;
}

function lightboxScreen(): string {
  const lb = state.lightbox;
  if (!lb) return "";
  const item = lb.images[lb.index];
  if (!item) return "";
  const width = contentWidth();
  const height =
    lb.kind === "still" && state.review ? Math.round(width / state.review.aspect) : h169(width);
  const many = lb.images.length > 1;
  const redoing = lb.kind === "still" && state.review?.redo === item.sceneId;
  return `${header(item.caption, many ? `<span class="tag2">${lb.index + 1} / ${lb.images.length}</span>` : "")}
  ${imgSlot(`big:${lb.kind}:${item.caption}:${lb.index}`, item.src, width, height, "", "big-img")}
  ${
    many
      ? `<div class="row mt"><div class="btn2 half" data-act="lb-prev">${t("lightbox.prev")}</div><div class="btn2 half" data-act="lb-next">${t("lightbox.next")}</div></div>`
      : ""
  }
  ${
    lb.kind === "still" && item.sceneId
      ? `<div class="btn2 mt" data-act="lb-redo" data-val="${item.sceneId}">${
          redoing ? t("lightbox.unmark") : redoLabel(item.sceneId)
        }</div>`
      : ""
  }
  <div class="btn mt" data-act="lb-close">${t("lightbox.close")}</div>`;
}

function render() {
  const sceneNote = document.getElementById("scenenote") as HTMLTextAreaElement | null;
  if (sceneNote && state.review) state.review.note = sceneNote.value ?? "";
  const note = document.getElementById("note") as HTMLTextAreaElement | null;
  if (note) state.note = note.value ?? "";
  for (const kind of ["img", "ref"] as const)
    imageList(kind).forEach((img, i) => {
      const input = document.getElementById(`${kind}-note-${i}`) as HTMLInputElement | null;
      if (input) img.note = input.value ?? "";
    });
  const storyFields: [string, "brief" | "script" | "note" | "tone" | "customLength" | "own"][] = [
    ["story-own", "own"],
    ["story-length-input", "customLength"],
    ["story-brief", "brief"],
    ["story-script", "script"],
    ["story-note", "note"],
    ["story-tone", "tone"],
  ];
  for (const [id, key] of storyFields) {
    const el = document.getElementById(id) as HTMLTextAreaElement | null;
    if (el) state.story[key] = el.value ?? "";
  }
  musicReadFields(state.music);
  captionsReadFields(state.captions);
  const keyField = document.getElementById("key-input") as HTMLInputElement | null;
  if (keyField) setup.keyDraft = keyField.value ?? "";
  const baseField = document.getElementById("base-input") as HTMLInputElement | null;
  const modelField = document.getElementById("model-input") as HTMLInputElement | null;
  if (baseField || modelField) {
    const id = state.settings.provider;
    state.settings = {
      ...state.settings,
      ...(baseField
        ? { baseURLs: { ...state.settings.baseURLs, [id]: baseField.value ?? "" } }
        : {}),
      ...(modelField ? { models: { ...state.settings.models, [id]: modelField.value ?? "" } } : {}),
    };
    store("settings", JSON.stringify(state.settings));
  }
  if (state.own) {
    const desc = document.getElementById("own-desc") as HTMLTextAreaElement | null;
    if (desc) state.own.description = desc.value ?? "";
    const redo = document.getElementById("own-redo") as HTMLTextAreaElement | null;
    if (redo) state.own.redoNote = redo.value ?? "";
  }
  // a new screen starts at the top; the same screen keeps its scroll position
  const screenKey = state.lightbox ? "lightbox" : state.screen;
  const scroll = screenKey === lastScreen ? (document.getElementById("scroll")?.scrollTop ?? 0) : 0;
  lastScreen = screenKey;
  const content = state.lightbox
    ? lightboxScreen()
    : state.screen === "own" && state.own
      ? ownScreen()
      : state.screen === "progress" && state.job
        ? progress()
        : state.screen === "review" && state.review
          ? reviewScreen()
          : state.screen === "settings"
            ? settings()
            : state.screen === "setup"
              ? setupScreen()
              : home();
  const bar = !state.lightbox && state.screen === "home" && state.tab === "range" ? rangeBar() : "";
  root.innerHTML = `<div class="scroll" id="scroll">${content}</div>${bar}`;
  fitScroll();
  fillImageSlots();
  // UXP shows a textarea's inner text but reports value as null until it is set, so the next render read
  // the note as empty and lost it; set the values explicitly
  const noteField = document.getElementById("note") as HTMLTextAreaElement | null;
  if (noteField) noteField.value = state.note;
  const sceneField = document.getElementById("scenenote") as HTMLTextAreaElement | null;
  if (sceneField && state.review) sceneField.value = state.review.note;
  for (const kind of ["img", "ref"] as const)
    imageList(kind).forEach((img, i) => {
      const input = document.getElementById(`${kind}-note-${i}`) as HTMLInputElement | null;
      if (input) input.value = img.note;
    });
  for (const [id, key] of [
    ["story-own", "own"],
    ["story-length-input", "customLength"],
    ["story-brief", "brief"],
    ["story-script", "script"],
    ["story-note", "note"],
    ["story-tone", "tone"],
  ] as const) {
    const el = document.getElementById(id) as HTMLTextAreaElement | null;
    if (el) el.value = state.story[key];
  }
  musicWriteFields(state.music);
  captionsWriteFields(state.captions);
  const keyAgain = document.getElementById("key-input") as HTMLInputElement | null;
  if (keyAgain) keyAgain.value = setup.keyDraft;
  if (state.own) {
    const desc = document.getElementById("own-desc") as HTMLTextAreaElement | null;
    if (desc) desc.value = state.own.description;
    const redo = document.getElementById("own-redo") as HTMLTextAreaElement | null;
    if (redo) redo.value = state.own.redoNote;
  }
  const scroller = document.getElementById("scroll");
  if (scroller) scroller.scrollTop = scroll;
  renderedWidth = root.clientWidth;
}

let lastScreen = "";

// ---------- actions ----------

/** One connect at a time: Open Kilnframe's retries and a Try Again click share it, so no socket is left over. */
let connecting: Promise<void> | null = null;
function connectCompanion(): Promise<void> {
  connecting ??= connectOnce().finally(() => {
    connecting = null;
  });
  return connecting;
}

async function connectOnce() {
  state.conn = "connecting";
  render();
  trace("connect: start");
  try {
    await withTimeout(
      session.open(() => {
        state.conn = "down";
        state.connError = t("conn.closed");
        trace("connect: closed");
        render();
      }),
      10_000,
      t("conn.timeout"),
    );
    trace("connect: ready");
    state.conn = "ok";
    captionsReconnected(state.captions);
    const theirs = session.ready?.protocol ?? PROTOCOL_VERSION;
    state.mismatch = protocolMismatch(theirs);
    state.appVersion = session.ready?.version || null;
    render();
    // the styles show as soon as they come; the computer check (a GPU probe, seconds) arrives after
    const systemCheck = session.request<ServerMessage>({ type: "system.check" }, "system");
    systemCheck.catch(() => undefined); // its failure is handled where it is awaited below
    const styles = await session.request<ServerMessage>({ type: "styles.list" }, "styles");
    state.styles = styles.styles as StyleCard[];
    render();
    // the line under the button needs the providers' names, models and the Claude Code sign-in
    void refreshProviders().then(render);
    const system = await systemCheck;
    state.system = system.report as typeof state.system;
    // the panel opens on its home screen; the setup guide waits under Settings (the
    // guide opening by itself confused more than it helped)
    if (state.screen === "setup" && !speechModelReady()) void downloadModels();
    void resumePending().catch((e: unknown) => trace(`resume threw: ${String(e)}`));
    trace(
      `connect: ${state.styles.length} styles, wav preset ${state.system?.wavPreset ? "found" : "missing"}`,
    );
  } catch (err) {
    state.conn = "down";
    state.connError = err instanceof Error ? err.message : String(err);
    trace(`connect: failed ${state.connError}`);
  }
  render();
}

/**
 * Frames of the footage for automatic and overlay mode: the plan looks at them to find the speaker, the
 * review shows overlays over them. Optional: a frame that fails is left out, the job goes on without it.
 */
async function exportFootageFrames(
  target: HostSequence,
  range: Range,
  jobDir: string,
): Promise<FootageFrame[]> {
  const frames: FootageFrame[] = [];
  for (const [k, seqS] of footageFrameTimes(range).entries()) {
    const name = `footage-${k + 1}.png`;
    try {
      const ok = await host().exportFrame(
        target,
        seqS,
        `${jobDir}/`,
        name,
        target.width,
        target.height,
      );
      if (ok) frames.push({ path: `${jobDir}/${name}`, seqS });
      else trace(`frames: ${name} at ${seqS.toFixed(2)} s was not written`);
    } catch (err) {
      trace(`frames: ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return frames;
}

/** Lyria 3.5's price per piece (the companion's music catalog); shown before any money is spent. */
const LYRIA_PRICE_USD = 0.08;

/** What the Music tab (music.ts) uses from the rest of the panel. */
const musicCtx: MusicCtx = {
  renderSettingsLost: async () => (await host().renderSettingsLost?.()) ?? false,
  reportLink: (error) => reportLink(error),
  esc: (s) => esc(s),
  seg: (name, value, options) => seg(name, value, options),
  render: () => render(),
  trace: (line) => trace(line),
  connected: () => state.conn === "ok" && wavPresetOk(),
  keySet: () => state.story.keySet,
  inOut: () => (state.seq?.range.source === "inout" ? state.seq.range : null),
  readSequence: () => readSequence(),
  request: (message, reply, timeoutMs) =>
    session.request<ServerMessage>(message as never, reply as never, timeoutMs),
  send: (message) => session.send(message),
  on: (listener) => session.on(listener),
  wavPreset: () => state.system?.wavPreset ?? "",
  frames: async (target, range, jobDir) =>
    (await exportFootageFrames(target, range, jobDir)).map((f) => ({
      path: f.path,
      atS: f.seqS - range.startS,
    })),
  withoutOurInserts: (target, range, fn) =>
    host().withoutOurInserts(target, range.startS, range.endS, fn),
  exportAudio: (target, range, file) =>
    host().exportRangeAudio(target, range.startS, range.endS, file, {
      wavPreset: state.system?.wavPreset ?? "",
    }),
  placeClips: (target, clips) => host().placeAudioClips(target, clips),
  rangeLine: (scope) => musicRangeLine(scope),
  slider: () => state.settings.musicLevel ?? -21,
  pricePerSong: () => LYRIA_PRICE_USD,
  openTerms: () => void host().openUrl("https://ai.google.dev/gemini-api/terms"),
};

/** What the Captions tab (captions.ts) uses from the rest of the panel. */
const captionsCtx: CaptionsCtx = {
  esc: (s) => esc(s),
  reportLink: (error) => reportLink(error),
  seg: (name, value, options) => seg(name, value, options),
  render: () => render(),
  trace: (line) => trace(line),
  connected: () => state.conn === "ok" && wavPresetOk(),
  inOut: () => (state.seq?.range.source === "inout" ? state.seq.range : null),
  rangeLine: (scope) => musicRangeLine(scope),
  videoStyle: () => state.style || null,
  // three tiles and two gaps of 8 fill the row: the third tile has no right margin
  tileWidth: () => Math.floor((scrollInnerWidth() - 2 * 8) / 3),
  readSequence: () => readSequence(),
  request: (message, reply, timeoutMs) =>
    session.request<ServerMessage>(message as never, reply as never, timeoutMs),
  send: (message) => session.send(message),
  on: (listener) => session.on(listener),
  providerParams: () => providerParams(),
  withoutOurInserts: (target, range, fn) =>
    host().withoutOurInserts(target, range.startS, range.endS, fn),
  exportAudio: (target, range, file) =>
    host().exportRangeAudio(target, range.startS, range.endS, file, {
      wavPreset: state.system?.wavPreset ?? "",
    }),
  ourInsertSpans: (target) => host().ourInsertSpans(target),
  placeInsert: (target, files, atS, handlesS, durationS) =>
    host().placeInsert(target, files, atS, handlesS, durationS),
  findCaptionClip: (target, mediaPath, atS, durationS) =>
    host().findCaptionClip(target, mediaPath, atS, durationS),
  replaceCaptionClip: (target, old, file, atS, durationS, videoTrack) =>
    host().replaceCaptionClip(target, old, file, atS, durationS, videoTrack),
  caret: (id) => {
    const el = document.getElementById(id) as HTMLTextAreaElement | null;
    return typeof el?.selectionStart === "number" ? el.selectionStart : null;
  },
  exportFrame: async (target, seconds, dir, name, width, height) =>
    (await host().exportFrame(target, seconds, `${dir}/`, name, width, height))
      ? `${dir}/${name}`
      : null,
  // UXP has a <video> element (its changelog adds timeUpdate in UXP 9.1 and the poster attribute, macOS only,
  // in 9.3: https://blog.developer.adobe.com/en/publish/2026/07/uxp-changelog-and-support-matrix), but neither
  // the HTML element list (https://developer.adobe.com/premiere-pro/uxp/) nor the Premiere samples say which
  // codecs or sources (a data: URL of an H.264 clip) it plays inside Premiere. Until that is tried there,
  // Premiere steps through stills; Resolve's panel is Chromium (Electron) and plays the clip.
  playsVideo: () => host().kind !== "premiere",
  img: (key, src, width, height) => imgSlot(key, src, width, height),
  refresh: (pictures) => {
    for (const [key, src] of Object.entries(pictures)) images.get(key)?.setAttribute("src", src);
    // a render now would take the focus from the colour field the editor is typing in
    if (!focusedField) render();
  },
  swapImage: (key, src) => images.get(key)?.setAttribute("src", src),
  stored: (key) => stored(key),
  store: (key, value) => store(key, value),
  saveFileCopy: (source, suggestedName) => host().saveFileCopy(source, suggestedName),
};

async function readSequence(): Promise<HostSequence | null> {
  try {
    const seq = await host().currentSequence();
    const busy = videoBusy({
      screen: state.screen,
      reviewing: state.review !== null,
      following: stopFollowing !== null,
      job: state.job,
    });
    if (isOtherVideo(state.seq?.guid, seq.id, busy)) {
      // the last video's result, note and images belong to that video
      state.job = null;
      state.note = "";
      state.images = [];
    }
    // the captions follow the open sequence, unless a caption job is running for the last one
    captionsSwitch(state.captions, state.seq?.guid, seq.id, stored);
    // the field stays "guid": unfinished series and pending jobs saved before the host interface use it
    state.seq = {
      name: seq.name,
      guid: seq.id,
      range: pickRange(seq.inSeconds, seq.outSeconds, seq.endSeconds),
      fps: seq.fps,
      fpsValue: seq.fpsValue,
      size: `${seq.width}x${seq.height}`,
      endS: seq.endSeconds,
    };
    state.seqError = "";
    // the style belongs to the video: reuse the one chosen for this sequence before
    const kept = stored(`style:${seq.id}`);
    if (kept && !state.style) state.style = kept;
    return seq;
  } catch (err) {
    state.seq = null;
    state.seqError = err instanceof Error ? err.message : String(err);
    return null;
  }
}

async function generate() {
  const target = await readSequence();
  if (!target || !state.seq || !wavPresetOk()) return render();
  const range = state.seq.range;
  // the style belongs to the video, also when it was carried over from another sequence
  store(`style:${target.id}`, state.style);
  state.job = {
    id: null,
    step: 0,
    scenes: [],
    last: t("detail.exportAudio"),
    startedAt: Date.now(),
    error: null,
    placed: null,
  };
  state.screen = "progress";
  render();
  try {
    const prepared = await session.request<ServerMessage>(
      {
        type: "job.prepare",
        projectPath: target.projectPath,
        sequenceName: target.name,
        ...(target.jobRoot ? { jobRoot: target.jobRoot } : {}),
      },
      "job.prepared",
    );
    const jobDir = String(prepared.jobDir);
    // a story sequence holds its narration from 0 on A1; under it is music, so read the voice alone
    const narration = await storyNarration(target.id);
    // a story sequence has no speaker under the animation, so there is nothing to sit beside: fullscreen
    const mode = narration ? "fullscreen" : state.mode;
    const audioPath = narration ?? `${jobDir}/sequence.wav`;
    // the frames, the speech and the picture are the editor's own: an earlier insert over the same range
    // (a second run) is switched off for the exports
    // where in the sequence the audio file starts: 0 for Premiere's whole-sequence export and a story narration
    let audioOffset = 0;
    const busy = await host().busyNote?.();
    if (busy && state.job) {
      state.job.last = busy;
      render();
    }
    const footage = await host().withoutOurInserts(target, range.startS, range.endS, async () => {
      const frames = mode === "fullscreen" ? [] : await exportFootageFrames(target, range, jobDir);
      if (narration) trace(`job: transcribing the story narration ${narration}`);
      else {
        const audio = await host().exportRangeAudio(target, range.startS, range.endS, audioPath, {
          wavPreset: state.system?.wavPreset ?? "",
        });
        if (!audio.ok) throw new Error(t("job.exportFailed"));
        audioOffset = audio.offsetSeconds;
      }
      // the preview of an insert with overlays sits on the range's real picture; optional, the job goes
      // on without it (series parts keep the still frame for now)
      // Resolve renders the picture with its own settings; Premiere needs its preview preset
      const preset = host().kind === "premiere" ? state.system?.previewPreset : "resolve";
      if (mode !== "fullscreen" && preset && range.durationS <= LONG_RANGE_SECONDS) {
        if (state.job) state.job.last = t("detail.exportPicture");
        render();
        try {
          const ok = await host().exportRangePicture(
            target,
            range.startS,
            range.endS,
            `${jobDir}/footage.mp4`,
            { previewPreset: preset },
          );
          trace(`job: range picture ${ok ? "exported" : "not exported"}`);
        } catch (err) {
          trace(`job: range picture failed ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return frames;
    });
    // Resolve could not put its Deliver settings back after the exports: said once, next to the result
    if ((await host().renderSettingsLost?.()) && state.job)
      state.job.note = t("resolve.settingsLost");
    const params = {
      audioPath,
      ...(narration ? { scriptPath: narration.replace(/narration\.wav$/, "story.txt") } : {}),
      ...audioRangeParams(range, audioOffset),
      outDir: jobDir,
      style: state.style,
      mode,
      ...(footage.length ? { frames: framesForRange(footage, range.startS, range.endS) } : {}),
      ...(state.format === "orijinal" ? {} : { format: FORMAT_SIZE[state.format] }),
      fps: target.fps,
      sequenceSize: `${target.width}x${target.height}`,
      ...(state.note.trim() ? { note: state.note.trim() } : {}),
      ...(state.images.some((i) => !i.error)
        ? {
            assets: state.images
              .filter((i) => !i.error)
              .map((i) =>
                i.note.trim() ? { path: i.path, note: i.note.trim() } : { path: i.path },
              ),
          }
        : {}),
      ...providerParams(),
    };
    if (range.durationS > LONG_RANGE_SECONDS)
      return await startParts(target, params, jobDir, footage, audioOffset);
    await submitJob(
      { ...params, stillsOnly: state.settings.review === "on" },
      target,
      range,
      params,
    );
  } catch (err) {
    failJob(err);
  }
}

/** Runs a job that needs no review (the split) and resolves with its result; progress goes to the job. */
function runQuietJob(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let id: string | null = null;
    const off = session.on((m) => {
      if (!id || m.jobId !== id) return;
      if (m.type === "job.progress" && state.job) {
        state.job.last = detailOf(String(m.message)) ?? state.job.last;
        render();
      } else if (m.type === "job.done") {
        off();
        resolve(m.result as Record<string, unknown>);
      } else if (m.type === "job.error") {
        off();
        reject(new Error(jobErrorText(m)));
      }
    });
    session
      .request<ServerMessage>(
        { type: "job.start", ref: String(Date.now()), params },
        "job.accepted",
      )
      .then((accepted) => {
        id = String(accepted.jobId);
        if (state.job) state.job.id = id;
      })
      .catch((err: unknown) => {
        off();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
  });
}

function loadSeries(): Series | null {
  try {
    return JSON.parse(stored("series") || "null") as Series | null;
  } catch {
    return null;
  }
}

function saveSeries() {
  store("series", state.series ? JSON.stringify(state.series) : "");
}

/** The stills of the parts, in memory only (data URLs); a resumed series reads them from disk again. */
const seriesStills = new Map<number, { stills: StillImage[]; aspect: number }>();
let seriesBusy = false;
/** The part shown on the progress screen. */
let seriesAt = 0;

class JobLost extends Error {}
/** The editor stopped the job; nothing is retried. */
class JobStopped extends Error {}

/** Applies a progress line to the job view: step, the part of the step done, the plan, the detail. */
function applyProgress(job: JobView, message: string) {
  trace(`job: ${message}`);
  const step = stepOf(message);
  if (step !== null && step > job.step) {
    job.step = step;
    job.sub = 0;
  }
  const sub = subProgress(message);
  if (sub !== null && step === job.step) job.sub = sub;
  const scenes = parsePlanLine(message);
  if (scenes) job.scenes = scenes;
  job.last = detailOf(message) ?? job.last;
}

/**
 * Starts a job, or follows one already running (after a reload), and resolves with its result. A job the
 * companion no longer knows (it restarted) rejects with JobLost, so the step can simply run again.
 */
function awaitJob(
  start: { params: Record<string, unknown> } | { jobId: string },
  onId?: (id: string) => void,
): Promise<JobResult> {
  return new Promise((resolve, reject) => {
    let id: string | null = "jobId" in start ? start.jobId : null;
    const off = session.on((m) => {
      if (!id || m.jobId !== id) return;
      if (m.type === "job.progress" && state.job) {
        applyProgress(state.job, String(m.message));
        render();
      } else if (m.type === "job.done") {
        off();
        resolve(m.result as JobResult);
      } else if (m.type === "job.error") {
        off();
        reject(new Error(jobErrorText(m)));
      } else if (m.type === "job.state" && m.state === "unknown") {
        off();
        reject(new JobLost(t("job.lost")));
      } else if (m.type === "job.cancelled") {
        off();
        reject(new JobStopped(t("job.stopped")));
      }
    });
    if (id) {
      session.send({ type: "job.get", jobId: id });
      return;
    }
    session
      .request<ServerMessage>(
        {
          type: "job.start",
          ref: String(Date.now()),
          params: (start as { params: Record<string, unknown> }).params,
        },
        "job.accepted",
      )
      .then((accepted) => {
        id = String(accepted.jobId);
        if (state.job) state.job.id = id;
        onId?.(id);
      })
      .catch((err: unknown) => {
        off();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
  });
}

/** One part's job parameters: its range, its own transcript and what is said around it. */
function partParams(series: Series, i: number): Record<string, unknown> {
  const part = series.parts[i] as SeriesPart;
  const prev = series.parts[i - 1];
  const next = series.parts[i + 1];
  return {
    ...series.base,
    rangeStartS: part.startS,
    rangeEndS: part.endS,
    outDir: part.outDir,
    transcriptPath: part.transcriptPath,
    ...(series.frames?.length
      ? {
          frames: framesForRange(
            series.frames,
            part.startS + (series.audioOffset ?? 0),
            part.endS + (series.audioOffset ?? 0),
          ),
        }
      : { frames: undefined }),
    part: {
      index: i + 1,
      count: series.parts.length,
      ...(prev ? { before: wordsAround(prev.text, 14, "end") } : {}),
      ...(next ? { after: wordsAround(next.text, 14, "start") } : {}),
    },
  };
}

/** Runs one job for a part, following the one it already had running when there is one. */
async function runPartJob(i: number, extra: Record<string, unknown>): Promise<JobResult> {
  const series = state.series as Series;
  const part = series.parts[i] as SeriesPart;
  if (part.jobId) {
    try {
      const r = await awaitJob({ jobId: part.jobId });
      part.jobId = null;
      saveSeries();
      return r;
    } catch (err) {
      if (!(err instanceof JobLost)) throw err;
      trace(`series: part ${i + 1} job lost, starting it again`);
      part.jobId = null;
    }
  }
  const r = await awaitJob({ params: { ...partParams(series, i), ...extra } }, (id) => {
    part.jobId = id;
    saveSeries();
  });
  part.jobId = null;
  saveSeries();
  return r;
}

/** A part's stills, from memory or, after a restart, from its folder; false when there are none yet. */
async function ensureStills(i: number): Promise<boolean> {
  if (seriesStills.has(i)) return true;
  const part = (state.series as Series).parts[i] as SeriesPart;
  const r = await session.request<ServerMessage>(
    { type: "review.load", outDir: part.outDir },
    "review",
  );
  const review = r.review as {
    stillImages: StillImage[];
    plan: { width: number; height: number };
  } | null;
  if (!review) return false;
  seriesStills.set(i, {
    stills: review.stillImages,
    aspect: review.plan.width / review.plan.height,
  });
  return true;
}

function showPart(i: number, phase: "stills" | "render") {
  const series = state.series as Series;
  seriesAt = i;
  state.job = {
    id: null,
    step: phase === "render" ? 5 : 1,
    scenes: [],
    last: t(phase === "render" ? "series.rendering" : "series.stills", {
      i: i + 1,
      n: series.parts.length,
    }),
    startedAt: Date.now(),
    error: null,
    placed: null,
  };
  state.screen = "progress";
  render();
}

async function placePart(i: number, r: JobResult, target: HostSequence) {
  const series = state.series as Series;
  const part = series.parts[i] as SeriesPart;
  if (!r.output) throw new Error(t("job.noOutput"));
  if (state.job) state.job.step = 6;
  render();
  const placed = await host().placeInsert(
    target,
    { video: r.output, sfx: r.sfxMix },
    part.startS + (series.audioOffset ?? 0),
    r.handlesSeconds,
    r.durationSeconds,
    series.tracks ?? undefined,
  );
  trace(`series: part ${i + 1} placed on V${placed.videoTrack + 1} and A${placed.audioTrack + 1}`);
  series.tracks ??= placed;
  part.state = "placed";
  series.cost = addCosts(series.cost ?? null, r.cost);
  saveSeries();
  if (state.job) {
    state.job.placed = placed;
    state.job.cost = series.cost;
  }
}

/** A long range: transcribe it once, split it at sentence ends, then make the parts. */
async function startParts(
  target: HostSequence,
  base: Record<string, unknown>,
  jobDir: string,
  frames: FootageFrame[],
  audioOffset: number,
) {
  if (state.job) state.job.last = t("detail.splitting");
  render();
  const r = await runQuietJob({
    kind: "parts",
    audioPath: base.audioPath,
    ...(base.scriptPath ? { scriptPath: base.scriptPath } : {}),
    rangeStartS: base.rangeStartS,
    rangeEndS: base.rangeEndS,
    outDir: `${jobDir}/parts`,
  });
  const list = r.parts as Omit<SeriesPart, "outDir" | "state" | "jobId">[];
  trace(`parts: ${list.map((p) => `${p.startS.toFixed(1)}-${p.endS.toFixed(1)}`).join(", ")}`);
  seriesStills.clear();
  state.series = {
    guid: target.id,
    title: target.name,
    jobDir,
    base,
    parts: list.map((p, i) => ({
      startS: p.startS,
      endS: p.endS,
      text: p.text,
      transcriptPath: p.transcriptPath,
      outDir: `${jobDir}/part-${i + 1}`,
      state: "new",
      jobId: null,
    })),
    tracks: null,
    phase: "stills",
    frames,
    audioOffset,
  };
  saveSeries();
  await runSeries();
}

/**
 * Makes what is missing, in order: every part's stills (or, with the review off, every part straight to the
 * timeline), then the review, then the render and placement of each approved part. Safe to call again after
 * a stop: finished parts are skipped and a running job is followed instead of started twice.
 */
async function runSeries() {
  const series = state.series;
  if (!series || seriesBusy) return;
  seriesBusy = true;
  try {
    const target = await readSequence();
    if (!target || target.id !== series.guid)
      throw new Error(t("series.openSequence", { name: series.title }));
    const review = state.settings.review === "on";
    if (series.phase === "stills") {
      for (const [i, part] of series.parts.entries()) {
        if (part.state === "placed") continue;
        if (part.state === "stills" && !part.jobId && (await ensureStills(i))) continue;
        showPart(i, "stills");
        const r = await runPartJob(i, review ? { stillsOnly: true } : {});
        if (r.output) await placePart(i, r, target);
        else {
          seriesStills.set(i, { stills: r.stillImages, aspect: r.plan.width / r.plan.height });
          part.state = "stills";
          saveSeries();
        }
      }
      if (series.parts.some((p) => p.state === "stills")) return openSeriesReview(target);
    }
    series.phase = "render";
    saveSeries();
    for (const [i, part] of series.parts.entries()) {
      if (part.state === "placed") continue;
      showPart(i, "render");
      await placePart(i, await runPartJob(i, { action: "render" }), target);
    }
    const n = series.parts.length;
    state.series = null;
    saveSeries();
    seriesStills.clear();
    if (state.job) {
      state.job.partsPlaced = n;
      state.job.step = 7;
    }
    state.review = null;
    state.screen = "home";
    render();
  } catch (err) {
    failJob(err);
  } finally {
    seriesBusy = false;
  }
}

/** One review for every part: stills grouped by part, keyed "part:scene". */
function openSeriesReview(target: HostSequence) {
  const series = state.series as Series;
  const stills: StillImage[] = [];
  let aspect = 16 / 9;
  series.parts.forEach((part, i) => {
    const got = seriesStills.get(i);
    if (part.state !== "stills" || !got) return;
    aspect = got.aspect;
    for (const st of got.stills) stills.push({ ...st, sceneId: `${i}:${st.sceneId}` });
  });
  state.review = {
    target,
    range: { startS: 0, endS: 0, durationS: 0, source: "inout", warning: null },
    params: {},
    stills,
    aspect,
    redo: null,
    note: "",
    series: true,
  };
  state.screen = "review";
  render();
}

/** Redo one scene of one part, then show the whole review again. */
async function redoSeriesScene(key: string, note: string) {
  const series = state.series;
  const target = state.review?.target;
  if (!series || !target) return;
  const [partText, sceneId] = key.split(":");
  const i = Number(partText);
  showPart(i, "stills");
  if (state.job) state.job.last = t("detail.rewriting", { scene: sceneName(sceneId ?? "") });
  try {
    const r = await runPartJob(i, { action: "recompose", sceneId, note });
    seriesStills.set(i, { stills: r.stillImages, aspect: r.plan.width / r.plan.height });
    openSeriesReview(target);
  } catch (err) {
    failJob(err);
  }
}

/** "Part 2 · Scene 3" for a series key, "Scene 3" for a plain scene id. */
function stillName(key: string): string {
  const [a, b] = key.split(":");
  return b ? `${t("parts.short", { i: Number(a) + 1 })} · ${sceneName(b)}` : sceneName(key);
}

/** The tag for the progress header while a long range is made in parts. */
function partTag(): string {
  const series = state.series;
  return series && state.screen === "progress"
    ? `<span class="tag2">${t("parts.tag", { i: seriesAt + 1, n: series.parts.length })}</span> `
    : "";
}

let stopFollowing: (() => void) | null = null;

/** One job listener at a time, so a resumed job is never placed twice. */
function followJob(target: HostSequence, range: Range, baseParams: Record<string, unknown>) {
  stopFollowing?.();
  const off = () => {
    remove();
    if (stopFollowing === off) stopFollowing = null;
  };
  const remove = session.on((m) => onJobMessage(m, target, range, baseParams, off));
  stopFollowing = off;
  return off;
}

/** Starts a job (a full run, a render of the approved stills, or one scene again) and follows it. */
async function submitJob(
  params: Record<string, unknown>,
  target: HostSequence,
  range: Range,
  baseParams: Record<string, unknown>,
) {
  const off = followJob(target, range, baseParams);
  try {
    const accepted = await session.request<ServerMessage>(
      { type: "job.start", ref: String(Date.now()), params },
      "job.accepted",
    );
    if (state.job) state.job.id = String(accepted.jobId);
    // kept until the result is handled, so a reloaded or woken panel can ask for it again
    store("pending", JSON.stringify({ jobId: accepted.jobId, guid: target.id, range, baseParams }));
  } catch (err) {
    off();
    throw err;
  }
}

function onJobMessage(
  m: ServerMessage,
  target: HostSequence,
  range: Range,
  baseParams: Record<string, unknown>,
  off: () => void,
) {
  const job = state.job;
  if (!job || (job.id && m.jobId !== job.id)) return;
  if (m.type === "job.progress") {
    applyProgress(job, String(m.message));
    render();
  } else if (m.type === "job.done") {
    off();
    store("pending", "");
    const r = m.result as JobResult;
    trace(`job: done, output ${r.output ?? "none (stills only)"}`);
    if (!r.output) {
      // stills only: open the review
      state.review = {
        target,
        range,
        params: baseParams,
        stills: r.stillImages,
        aspect: r.plan.width / r.plan.height,
        redo: null,
        note: "",
      };
      state.screen = "review";
      render();
      return;
    }
    job.step = 6;
    render();
    host()
      .placeInsert(
        target,
        { video: r.output, sfx: r.sfxMix },
        range.startS,
        r.handlesSeconds,
        r.durationSeconds,
      )
      .then((placed) => {
        trace(`job: placed on V${placed.videoTrack + 1} and A${placed.audioTrack + 1}`);
        job.placed = placed;
        job.cost = r.cost ?? null;
        job.step = 7;
        state.review = null;
        state.screen = "home";
        render();
      })
      .catch(failJob);
  } else if (m.type === "job.error") {
    off();
    store("pending", "");
    failJob(new Error(jobErrorText(m)));
  } else if (m.type === "job.cancelled") {
    off();
    store("pending", "");
    failJob(new JobStopped(t("job.stopped")));
  } else if (m.type === "job.state" && m.state === "unknown") {
    // the companion restarted and no longer knows the job; the files stay in the job folder
    off();
    store("pending", "");
    failJob(new Error(t("job.lost")));
  }
}

interface PendingJob {
  jobId: string;
  guid: string;
  range: Range;
  baseParams: Record<string, unknown>;
}

/**
 * A job whose result the panel never handled (the panel was reloaded, or Premiere slept and missed the
 * broadcast): follow it again and ask the companion for its state.
 */
async function resumePending() {
  let p: PendingJob | null;
  try {
    p = JSON.parse(stored("pending") || "null") as PendingJob | null;
  } catch {
    p = null;
  }
  if (!p?.jobId) return;
  const target = await readSequence();
  if (!target || target.id !== p.guid) {
    trace(`resume: job ${p.jobId} belongs to another sequence`);
    return;
  }
  trace(`resume: asking for job ${p.jobId}`);
  if (state.job?.id !== p.jobId)
    state.job = {
      id: p.jobId,
      step: 0,
      scenes: [],
      last: t("detail.resume"),
      startedAt: Date.now(),
      error: null,
      placed: null,
    };
  state.screen = "progress";
  render();
  followJob(target, p.range, p.baseParams);
  session.send({ type: "job.get", jobId: p.jobId });
}

/** Approve: render the reviewed project. Redo: write the marked scene again with the note. */
async function continueReview(action: "render" | "recompose") {
  const r = state.review;
  if (!r) return;
  const note =
    (document.getElementById("scenenote") as HTMLTextAreaElement | null)?.value ?? r.note;
  if (r.series) {
    if (action === "recompose" && r.redo) return redoSeriesScene(r.redo, (note ?? "").trim());
    if (state.series) state.series.phase = "render";
    saveSeries();
    state.review = null;
    return runSeries();
  }
  state.job = {
    id: null,
    step: action === "render" ? 5 : 2,
    scenes: state.job?.scenes ?? [],
    last:
      action === "render"
        ? t("detail.video")
        : t("detail.rewriting", { scene: sceneName(r.redo ?? "") }),
    startedAt: Date.now(),
    error: null,
    placed: null,
  };
  state.screen = "progress";
  render();
  try {
    await submitJob(
      {
        ...r.params,
        action,
        ...(action === "recompose" ? { sceneId: r.redo, note: (note ?? "").trim() } : {}),
      },
      r.target,
      r.range,
      r.params,
    );
  } catch (err) {
    failJob(err);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * A failed job's message in the panel's language when its kind is one the user can act on (the companion
 * passes the provider's kind along); otherwise the companion's own message.
 */
function jobErrorText(msg: unknown): string {
  const m = msg as { message?: unknown; kind?: unknown };
  if (m.kind === "cut-off") return t("err.cutOff");
  // the core speaks English; what the panel can say in its own language it says (the original is in the log)
  const readable = readableJobText(String(m.message));
  if (readable) trace(`job: ${String(m.message)}`);
  return readable ?? String(m.message);
}

function failJob(err: unknown) {
  trace(`job: failed ${err instanceof Error ? err.message : String(err)}`);
  const message = err instanceof Error ? err.message : String(err);
  const series = state.series;
  if (!state.job)
    state.job = {
      id: null,
      step: 0,
      scenes: [],
      last: "",
      startedAt: Date.now(),
      error: null,
      placed: null,
    };
  state.job.confirmStop = false;
  state.job.reportable = !(err instanceof JobStopped);
  state.job.error =
    series && !(err instanceof JobStopped)
      ? t("job.partFailed", { i: seriesAt + 1, n: series.parts.length, message })
      : message;
  state.screen = "home";
  render();
}

/** The element carrying data-act for an event target; walked by hand, closest() is missing in some UXP. */
function actionTarget(target: EventTarget | null): HTMLElement | null {
  let el = target as HTMLElement | null;
  while (el && el !== root && !el.getAttribute("data-act")) el = el.parentElement;
  return el && el !== root ? el : null;
}

/**
 * Actions run on pointerup over the element that got the pointerdown, not on click: UXP sends no click for a
 * second click that follows quickly (it reads it as part of a double click), so fast clicks were lost.
 */
let pressed: HTMLElement | null = null;
let pressedSeen = false;
// While Premiere is in the background the first click on the panel only brings Premiere forward: no pointer
// event reaches the panel (measured in 26.5.2), so the buttons look dimmed whenever a click could be lost.
// Awake: the panel has focus, or the pointer moves over it (moves only arrive while Premiere is in front).
// The window's own focus and blur have no element as their target; a text field's do.
const ownWindow = (event: Event) => !(event.target as { tagName?: string } | null)?.tagName;
let panelFocused = false;
const asleep = (on: boolean) => root.classList[on ? "add" : "remove"]("asleep");
document.addEventListener(
  "focus",
  (event) => {
    if (!ownWindow(event)) return;
    panelFocused = true;
    asleep(false);
  },
  true,
);
document.addEventListener(
  "blur",
  (event) => {
    if (!ownWindow(event)) return;
    panelFocused = false;
    asleep(true);
  },
  true,
);
for (const name of ["pointerdown", "pointermove"])
  root.addEventListener(name, () => asleep(false), true);
// leaving the panel while another Premiere panel has focus: Premiere may go to the background unnoticed
for (const name of ["pointerleave", "mouseleave"])
  root.addEventListener(name, () => {
    if (!panelFocused) asleep(true);
  });

root.addEventListener("pointerdown", (event) => {
  pressed = actionTarget(event.target);
  pressedSeen = true;
});
root.addEventListener("pointerup", (event) => {
  const el = actionTarget(event.target);
  // while a text field has focus UXP sends no pointerdown for the next click, only pointerup, so a lone
  // pointerup counts as a click too
  const same = el !== null && (pressedSeen ? el === pressed : true);
  pressed = null;
  pressedSeen = false;
  if (same) runAction(el);
});

/**
 * While a text field has focus, UXP delivers no event at all for a click elsewhere in the panel; the click is
 * lost and the field keeps its focus. So when the pointer reaches a button while a field has focus and the
 * editor is not typing (nothing typed for half a second), the field gives up its focus first, and the
 * click then arrives as usual. Acting on focus loss instead fired buttons when the window changed.
 */
let focusedField: HTMLElement | null = null;
let lastTyped = 0;
root.addEventListener("focusin", (event) => {
  const el = event.target as HTMLElement | null;
  focusedField = el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT") ? el : null;
});
root.addEventListener("focusout", (event) => {
  if (event.target === focusedField) focusedField = null;
});
root.addEventListener("keydown", () => {
  lastTyped = Date.now();
});
// the Captions tab previews the selected look in the colours being typed, once the typing pauses
root.addEventListener("input", (event) => {
  const id = (event.target as HTMLElement | null)?.id ?? "";
  if (id.startsWith("cap-color-"))
    captionsColorInput(state.captions, captionsCtx, () => readColorFields());
  // a typed line is kept in the job folder once the typing pauses
  else if (id.startsWith("cap-line-"))
    captionsLineInput(state.captions, captionsCtx, () => captionsReadFields(state.captions));
  // the word count under a pasted story follows the typing, without a render that would move the cursor
  else if (id === "story-own") {
    const text = (event.target as HTMLTextAreaElement).value ?? "";
    const line = document.getElementById("story-own-count");
    if (line) line.innerHTML = ownCountLine(text, state.story.language);
  }
});
root.addEventListener("pointermove", (event) => {
  if (!focusedField || Date.now() - lastTyped < 500) return;
  if (!actionTarget(event.target)) return;
  const field = focusedField;
  focusedField = null;
  field.blur();
});

async function saveKey(id: string) {
  const input = document.getElementById("key-input") as HTMLInputElement | null;
  const key = (input?.value ?? setup.keyDraft).trim();
  if (!key) {
    setup.error = t("prov.keyEmpty");
    return render();
  }
  setup.error = null;
  try {
    await session.request<ServerMessage>({ type: "keys.set", provider: id, key }, "keys.saved");
    trace(`settings: key saved for ${id}`);
    setup.editingKey = null;
    setup.keyDraft = "";
    if (id === "custom") customKey = true;
    if (id === "gemini") void loadVoices().catch(() => undefined);
  } catch (err) {
    setup.error = err instanceof Error ? err.message : String(err);
  }
  await refreshProviders();
}

async function deleteKey(id: string) {
  setup.confirmDelete = null;
  try {
    await session.request<ServerMessage>({ type: "keys.delete", provider: id }, "keys.deleted");
    trace(`settings: key deleted for ${id}`);
    if (id === "custom") customKey = false;
  } catch (err) {
    setup.error = err instanceof Error ? err.message : String(err);
  }
  await refreshProviders();
}

/** Opens the agent's own update in a terminal, then looks every 5 s (up to 5 minutes) until it is done. */
async function updateAgent(id: string) {
  setup.updating = id;
  setup.error = null;
  render();
  const before = setup.updates[id]?.current;
  try {
    await session.request<ServerMessage>(
      { type: "agent.update", agent: id },
      "agent.update.opened",
    );
    trace(`settings: update opened for ${id}`);
  } catch (err) {
    setup.updating = null;
    setup.error = err instanceof Error ? err.message : String(err);
    return render();
  }
  const started = Date.now();
  const look = async () => {
    await refreshProviders();
    const now = setup.updates[id];
    if ((now && now.current !== before) || Date.now() - started > 5 * 60_000) {
      setup.updating = null;
      trace(`settings: ${id} ${now?.current ?? "?"} after the update`);
      return render();
    }
    setTimeout(() => void look(), 5000);
  };
  setTimeout(() => void look(), 5000);
}

function agentName(id: string): string {
  return id === "claude-code" ? "Claude Code" : id === "codex" ? "Codex" : "Grok";
}

/** Runs the agent's own sign-out, then reads the sign-in states again; Sign In then takes another account. */
async function signOutAgent(id: string) {
  setup.confirmLogout = null;
  setup.signingOut = id;
  setup.error = null;
  render();
  try {
    const r = await session.request<ServerMessage>(
      { type: "agent.logout", agent: id },
      "agent.logout.done",
    );
    const done = r.type === "agent.logout.done" ? r : null;
    if (done && !done.ok)
      setup.error =
        done.error === "busy"
          ? t("prov.signOutBusy")
          : t("prov.signOutFailed", { name: agentName(id) });
    trace(`settings: ${id} sign-out ${done?.ok ? "done" : `failed ${done?.error ?? ""}`}`);
    await refreshProviders();
    // a sign-in Kilnframe cannot end (Claude Code's CLAUDE_CODE_OAUTH_TOKEN): still signed in after it
    if (done?.ok && agentState(id)?.loggedIn)
      setup.error = t("prov.signOutStill", { name: agentName(id) });
  } catch (err) {
    setup.error = err instanceof Error ? err.message : String(err);
  }
  setup.signingOut = null;
  render();
}

/** Opens the agent's own sign-in in a terminal, then looks every 3 s (up to 5 minutes) until it is done. */
async function signInAgent(id: string) {
  setup.signingIn = id;
  setup.error = null;
  render();
  try {
    await session.request<ServerMessage>({ type: "agent.login", agent: id }, "agent.login.opened");
    trace(`settings: sign-in opened for ${id}`);
  } catch (err) {
    setup.signingIn = null;
    setup.error = err instanceof Error ? err.message : String(err);
    return render();
  }
  const started = Date.now();
  const look = async () => {
    await refreshProviders();
    const a = agentState(id);
    if (a?.loggedIn || Date.now() - started > 5 * 60_000) {
      setup.signingIn = null;
      trace(`settings: ${id} ${a?.loggedIn ? "signed in" : "sign-in not finished"}`);
      return render();
    }
    setTimeout(() => void look(), 3000);
  };
  setTimeout(() => void look(), 3000);
}

async function runProviderTest(id: string) {
  setup.test = { provider: id, running: true, result: null };
  render();
  const params = state.settings.provider === id ? providerParams() : { provider: id };
  try {
    const r = await session.request<ServerMessage>(
      { type: "providers.test", ...params },
      "providers.tested",
      120_000,
    );
    setup.test = { provider: id, running: false, result: r.result as ProviderTest };
    trace(`settings: test ${id} ${JSON.stringify(r.result)}`);
  } catch (err) {
    setup.test = {
      provider: id,
      running: false,
      result: {
        ok: false,
        vision: false,
        model: "",
        ms: 0,
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
  if (LOCAL_PROVIDERS.has(id)) void loadServed(id);
  render();
}

function runAction(el: HTMLElement) {
  const act = el.getAttribute("data-act");
  const val = el.getAttribute("data-val") ?? "";
  if (el.hasAttribute("disabled")) return;
  if (act === "style-change") state.styleOpen = !state.styleOpen;
  else if (act === "style") {
    state.style = val;
    state.styleOpen = false;
    if (state.seq) store(`style:${state.seq.guid}`, val);
  } else if (act === "format") state.format = val as Format;
  else if (act === "mode") state.mode = val as Mode;
  else if (act === "redo" && state.review) {
    state.review.redo = state.review.redo === val ? null : val;
    state.review.note = "";
  } else if (act === "gallery") {
    const s = state.styles.find((x) => x.name === state.style);
    const stills = s ? styleStills(s).stills : [];
    state.lightbox = {
      kind: "style",
      images: stills.map((src) => ({ src, caption: localized(s?.displayName) })),
      index: Number(val) || 0,
    };
  } else if (act === "zoom" && state.review) {
    const shown = state.review.stills.filter((st) => st.image);
    state.lightbox = {
      kind: "still",
      images: shown.map((st) => ({
        src: st.image as string,
        caption: stillName(st.sceneId),
        sceneId: st.sceneId,
      })),
      index: Math.max(
        0,
        shown.findIndex((st) => st.sceneId === val),
      ),
    };
  } else if ((act === "lb-prev" || act === "lb-next") && state.lightbox) {
    const n = state.lightbox.images.length;
    state.lightbox.index = (state.lightbox.index + (act === "lb-next" ? 1 : n - 1)) % n;
  } else if (act === "lb-redo" && state.review) {
    state.review.redo = state.review.redo === val ? null : val;
    state.review.note = "";
    state.lightbox = null;
  } else if (act === "lb-close") state.lightbox = null;
  else if (act === "tab") {
    state.tab = val as Tab;
    // the music needs the Gemini key: its state comes with the voices
    if (state.tab === "music" && state.conn === "ok")
      void loadVoices()
        .then(render)
        .catch(() => undefined);
  } else if (act && musicAct(state.music, musicCtx, act, val)) {
    /* handled by the Music tab */
  } else if (act && captionsAct(state.captions, captionsCtx, act, val)) {
    /* handled by the Captions tab */
  } else if (act === "music-level") {
    state.settings = { ...state.settings, musicLevel: Number(val) };
    store("settings", JSON.stringify(state.settings));
  } else if (act === "story-length") {
    const choice = (["30", "60", "120", "custom"] as const).find((c) => c === val);
    if (choice) {
      state.story.lengthChoice = choice;
      state.story.error = null;
      if (choice !== "custom") state.story.durationS = Number(choice);
    }
  } else if (act === "story-lang") state.story.language = val as "tr" | "en";
  else if (act === "story-source") {
    state.story.source = val === "own" ? "own" : "write";
    state.story.error = null;
    store("story-source", state.story.source);
  } else if (act === "story-own-go") {
    render();
    const st = state.story;
    const sum = ownSummary(st.own, st.language);
    if (!sum.words) {
      st.error = t("story.ownEmpty");
      return render();
    }
    if (sum.tooLong) {
      st.error = t("story.ownTooLong", { max: formatDuration(OWN_MAX_S) });
      return render();
    }
    // the editor's own words go to the narration screen as they are: no model writes or changes them
    st.error = null;
    st.script = ownParagraphs(st.own);
    st.title = ownTitle(st.own);
    st.voiceStyle = "";
    st.stage = "script";
    render();
    return void loadVoices()
      .then(render)
      .catch((e: unknown) => trace(`voices threw: ${String(e)}`));
  } else if (act === "story-write") {
    render();
    if (!state.story.brief.trim()) {
      state.story.error = t("story.needBrief");
      return render();
    }
    if (state.story.lengthChoice === "custom") {
      const seconds = parseLength(state.story.customLength);
      if (seconds === null || seconds < STORY_LENGTH.minS || seconds > STORY_LENGTH.maxS) {
        state.story.error = t("story.badLength");
        return render();
      }
      state.story.durationS = seconds;
    }
    state.story.error = null;
    return writeStoryJob(false);
  } else if (act === "story-rewrite") {
    render();
    if (!state.story.note.trim()) return;
    return writeStoryJob(true);
  } else if (act === "story-format") {
    const f = (["orijinal", "landscape", "portrait", "square"] as const).find((x) => x === val);
    if (f) {
      state.story.format = f;
      store("story-format", f);
    }
  } else if (act === "story-music") {
    state.story.music = val === "off" ? "off" : "on";
    store("story-music", state.story.music);
  } else if (act === "story-voice") {
    state.story.voice = val;
    store("story-voice", val);
  } else if (act === "story-voices-all") state.story.allVoices = !state.story.allVoices;
  else if (act === "story-stop") {
    state.voicePlaying = "";
    try {
      session.send({ type: "speech.stop" });
    } catch (err) {
      trace(`stop voice failed: ${String(err)}`);
    }
  } else if (act === "story-listen") {
    // the first listen to a voice is made first (a few seconds); Stop shows from the click on
    state.voicePlaying = val || state.story.voice;
    render();
    void session
      .request<ServerMessage>(
        { type: "speech.preview", voice: val || state.story.voice, language: state.story.language },
        "speech.played",
        60_000,
      )
      .catch((e: unknown) => {
        state.voicePlaying = "";
        state.story.error = t("story.failed", {
          message: e instanceof Error ? e.message : String(e),
        });
        render();
      });
    return;
  } else if (act === "story-make") {
    render();
    if (!state.story.script.trim()) return;
    return void makeStorySequence();
  } else if (act === "story-new") {
    state.story = newStory();
    state.tab = "story";
  } else if (act === "custom-style") {
    state.own ??= {
      stage: "new",
      description: "",
      refs: [],
      jobId: null,
      last: "",
      startedAt: 0,
      error: null,
      result: null,
      redoNote: "",
      confirmDelete: false,
    };
    state.screen = "own";
  } else if (act === "own-close") {
    if (state.own?.stage !== "running") {
      // a reviewed style stays saved; closing only leaves the screen
      if (state.own?.stage === "review") state.own = null;
      state.screen = "home";
    }
  } else if (act === "add-ref")
    return void addImages("ref").catch((e: unknown) => trace(`refs threw: ${String(e)}`));
  else if (act === "remove-ref" && state.own) {
    render();
    state.own.refs.splice(Number(val), 1);
  } else if (act === "own-create" && state.own) {
    render();
    const o = state.own;
    if (!o.description.trim() && !o.refs.some((r) => !r.error)) {
      o.error = t("own.needInput");
      return render();
    }
    return void startStyleJob({
      description: o.description.trim(),
      references: o.refs
        .filter((r) => !r.error)
        .map((r) => (r.note.trim() ? { path: r.path, note: r.note.trim() } : { path: r.path })),
    });
  } else if (act === "own-redo" && state.own?.result) {
    render();
    if (!state.own.redoNote.trim()) return;
    return void startStyleJob({ revise: state.own.result.name, note: state.own.redoNote.trim() });
  } else if (act === "own-keep" && state.own?.result) {
    const name = state.own.result.name;
    state.own = null;
    state.screen = "home";
    void refreshStyles()
      .then(() => {
        state.style = name;
        if (state.seq) store(`style:${state.seq.guid}`, name);
        render();
      })
      .catch((e: unknown) => trace(`styles refresh threw: ${String(e)}`));
  } else if (act === "own-delete" && state.own) state.own.confirmDelete = true;
  else if (act === "own-delete-yes" && state.own?.result) {
    const name = state.own.result.name;
    void session
      .request<ServerMessage>({ type: "styles.delete", name }, "styles.deleted")
      .then(refreshStyles)
      .then(() => {
        if (state.style === name) state.style = "";
        state.own = null;
        state.screen = "home";
        render();
      })
      .catch((e: unknown) => {
        if (state.own) state.own.error = e instanceof Error ? e.message : String(e);
        render();
      });
    return;
  } else if (act === "own-zoom" && state.own?.result) {
    const r = state.own.result;
    state.lightbox = {
      kind: "style",
      images: r.stillImages
        .filter((st) => st.image)
        .map((st) => ({ src: st.image as string, caption: localized(r.displayName) })),
      index: Number(val) || 0,
    };
  } else if (act === "add-img")
    return void addImages("img").catch((e: unknown) => trace(`images threw: ${String(e)}`));
  else if (act === "remove-img") {
    render(); // keep the notes typed so far
    state.images.splice(Number(val), 1);
  } else if (act === "cancel-review") {
    trace("review: cancelled");
    leaveReview();
    if (state.review?.series) {
      state.series = null;
      saveSeries();
      seriesStills.clear();
    }
    state.review = null;
    state.job = null;
    state.screen = "home";
  } else if (act === "series-later") {
    trace("review: series kept for later");
    leaveReview();
    state.review = null;
    state.job = null;
    state.screen = "home";
  } else if (act === "series-continue") return void runSeries();
  else if (act === "series-drop") {
    state.series = null;
    saveSeries();
    seriesStills.clear();
  } else if (act === "approve") return void continueReview("render");
  else if (act === "recompose") return void continueReview("recompose");
  else if (act === "review" || act === "lang") {
    state.settings = { ...state.settings, [act]: val };
    store("settings", JSON.stringify(state.settings));
    if (act === "lang") applyLang();
  } else if (act === "ontop") {
    host().onTop?.set(val === "on");
  } else if (act === "provider") {
    state.settings = { ...state.settings, provider: val };
    store("settings", JSON.stringify(state.settings));
    setup.editingKey = null;
    setup.confirmDelete = null;
    if (LOCAL_PROVIDERS.has(val) || val === "openrouter") void loadServed(val);
  } else if (act === "lm-thinking") {
    state.settings = {
      ...state.settings,
      thinking: {
        ...state.settings.thinking,
        [state.settings.provider]: val === "on" ? "on" : "off",
      },
    };
    store("settings", JSON.stringify(state.settings));
  } else if (act === "pmodel") {
    const id = state.settings.provider;
    state.settings = CLAUDE_KINDS.has(id)
      ? { ...state.settings, model: val }
      : { ...state.settings, models: { ...state.settings.models, [id]: val } };
    store("settings", JSON.stringify(state.settings));
  } else if (act === "key-edit") setup.editingKey = val;
  else if (act === "key-cancel") setup.editingKey = null;
  else if (act === "key-delete") setup.confirmDelete = val;
  else if (act === "key-delete-no") setup.confirmDelete = null;
  else if (act === "key-delete-yes") return void deleteKey(val);
  else if (act === "key-save") return void saveKey(val);
  else if (act === "prov-test") return void runProviderTest(val);
  else if (act === "open-app") return void openApp();
  else if (act === "agent-login") return void signInAgent(val);
  else if (act === "agent-logout") setup.confirmLogout = val;
  else if (act === "agent-logout-no") setup.confirmLogout = null;
  else if (act === "agent-logout-yes") return void signOutAgent(val);
  else if (act === "agent-update") return void updateAgent(val);
  else if (act === "agent-recheck") return void refreshProviders();
  else if (act === "copy-install") return void copyInstall(val as AgentId);
  else if (act === "or-all") onboard.allModels = !onboard.allModels;
  else if (act === "open-url") {
    host()
      .openUrl(val)
      .catch((err: unknown) => trace(`open url failed: ${String(err)}`));
  } else if (act === "setup-open") openSetup();
  else if (act === "setup-finish") finishSetup();
  else if (act === "setup-more") onboard.allProviders = true;
  else if (act === "setup-download") return void downloadModels();
  else if (act === "setup-pass") onboard.passed.add(Number(val));
  else if (act === "setup-story") {
    finishSetup();
    state.tab = "story";
    state.story.stage = "brief";
    state.story.brief = t("setup.sampleBrief");
    state.story.lengthChoice = "30";
    state.story.durationS = 30;
  } else if (act === "setup-range") {
    finishSetup();
    state.tab = "range";
  } else if (act === "settings") {
    state.screen = "settings";
    void refreshProviders();
    if (LOCAL_PROVIDERS.has(state.settings.provider) || state.settings.provider === "openrouter")
      void loadServed(state.settings.provider);
  } else if (act === "home") state.screen = "home";
  else if (act === "stop" && state.job) state.job.confirmStop = true;
  else if (act === "stop-no" && state.job) state.job.confirmStop = false;
  else if (act === "stop-yes" && state.job) {
    // the companion ends the job and everything it started; job.cancelled brings the panel home
    trace(`job: stopped by the editor (${state.job.id ?? "not started yet"})`);
    host().cancelExports?.();
    if (state.job.id) session.send({ type: "job.cancel", jobId: state.job.id });
    else failJob(new JobStopped(t("job.stopped")));
  } else if (act === "reconnect") return void connectCompanion();
  else if (act === "app-update") {
    state.updateBusy = false;
    try {
      session.send({ type: "app.update.install" });
    } catch (err) {
      trace(`update request failed: ${String(err)}`);
    }
  } else if (act === "generate") return void generate();
  render();
}

/**
 * Images are sized from the panel width, so a resized panel lays them out again. Only a real width change
 * counts: UXP also fires resize after a render (the content height changes), and re-rendering on that looped
 * every 170 ms and swallowed clicks that landed between two renders.
 */
let resizeTimer: ReturnType<typeof setTimeout> | null = null;
let renderedWidth = 0;
window.addEventListener("resize", () => {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (root.clientWidth !== renderedWidth) render();
    // a taller or shorter panel only moves the bar: no render, which could swallow a click
    else fitScroll();
  }, 150);
});

/** How long a background look at the sequence waits for the editor before it gives up and tries again later. */
const READ_WAIT_MS = 8000;

/** Reads the sequence again and re-renders only when the range or the sequence changed: a render in the
 * middle of a click swallowed it. */
let rereading = false;
function rereadSequence() {
  if (rereading) return;
  rereading = true;
  const before = JSON.stringify(state.seq);
  void within(readSequence(), READ_WAIT_MS)
    .then(() => {
      if (JSON.stringify(state.seq) !== before) render();
    })
    .catch(() => trace("sequence read: the editor did not answer"))
    .finally(() => {
      rereading = false;
    });
}

/** The in and out points alone, twice a second; the whole sequence only when another one is open. */
let lookingAtRange = false;
async function lookAtRange(quick: () => Promise<QuickRange>) {
  if (lookingAtRange || rereading) return;
  lookingAtRange = true;
  try {
    const before = state.seq;
    const q = await within(quick(), READ_WAIT_MS);
    // a full read (focus, another tick) may have opened another sequence meanwhile: the next look sees it
    if (state.seq !== before) return;
    const w = rangeWatch(state.seq, q);
    if (w.kind === "full") rereadSequence();
    else if (w.kind === "range" && state.seq) {
      state.seq = { ...state.seq, range: w.range, endS: w.endS };
      render();
    }
  } catch {
    // no sequence open, or the editor busy: the full read says why, once every 1.5 s as before
    if (state.seq || watchTick % 3 === 0) rereadSequence();
  } finally {
    lookingAtRange = false;
  }
}

// Premiere has no event for a new in or out point (26.5 lists sequence activated, closed and selection
// changed only), so the range tab (and the Music tab's first screen) looks while it is open: the points
// alone every 0.5 s where the host can ask for them quickly, else the whole sequence every 1.5 s
let watchTick = 0;
setInterval(() => {
  watchTick++;
  if (
    state.screen !== "home" ||
    !watchesSequence(state.tab, state.music.stage, state.captions.stage) ||
    state.lightbox ||
    pressed
  )
    return;
  const quick = host().quickRange?.bind(host());
  if (quick) void lookAtRange(quick);
  else if (watchTick % 3 === 0) rereadSequence();
}, 500);

/** Re-read the sequence when the panel gains focus, so a new in/out shows up. */
window.addEventListener("focus", () => {
  if (state.screen === "home") rereadSequence();
  // a result broadcast while Premiere was napping may have been missed
  else if (state.screen === "progress" && state.job?.id && session.connected)
    session.send({ type: "job.get", jobId: state.job.id });
});

applyLang();
render();
readSequence()
  .then(render)
  .catch((e: unknown) => trace(`readSequence threw: ${String(e)}`));
connectCompanion().catch((e: unknown) => trace(`connectCompanion threw: ${String(e)}`));
// for the UXP debugger console
(window as unknown as { motionInsert: unknown }).motionInsert = {
  state,
  connectCompanion,
  session,
  render,
  captionsCtx,
};

/**
 * How to install a missing agent: the terminal program, not the desktop app, with the vendor's own install
 * command for this computer (checked on their pages, 11 Oct 2026), with a Copy button: a text field alone
 * cannot be selected in Premiere's panels.
 */
function agentInstallHelp(id: AgentId): string {
  const win = isWindows();
  const signIn = { "claude-code": "claude", codex: "codex", grok: "grok" };
  const copy = setup.copied === id ? t("prov.copied") : t("prov.copy");
  return `<div class="note">${t(`prov.cliOnly.${id}`)}</div>
  <div class="note muted">${t("prov.installPaste", { terminal: win ? "PowerShell" : "Terminal" })}</div>
  <div class="cmd-row"><input class="img-note cmd" type="text" value="${esc(installCommand(id))}"><div class="pbtn" data-act="copy-install" data-val="${id}">${copy}</div></div>
  <div class="note muted">${t("prov.installThen", { command: signIn[id] })}</div>`;
}

type AgentId = "claude-code" | "codex" | "grok";

function installCommand(id: AgentId): string {
  const win = isWindows();
  const commands = {
    "claude-code": win
      ? "irm https://claude.ai/install.ps1 | iex"
      : "curl -fsSL https://claude.ai/install.sh | bash",
    codex: win
      ? 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"'
      : "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
    grok: win
      ? "irm https://x.ai/cli/install.ps1 | iex"
      : "curl -fsSL https://x.ai/cli/install.sh | bash",
  };
  return commands[id];
}

/** Puts text on the clipboard: UXP's setContent in Premiere, the web's writeText in Resolve and the demo. */
async function copyText(text: string): Promise<void> {
  const clip = navigator.clipboard as Clipboard & {
    setContent?: (data: Record<string, string>) => Promise<void>;
  };
  if (clip.setContent) await clip.setContent({ "text/plain": text });
  else await clip.writeText(text);
}

async function copyInstall(id: AgentId) {
  try {
    await copyText(installCommand(id));
    setup.copied = id;
  } catch (err) {
    trace(`copy failed: ${String(err)}`);
    setup.copied = null;
  }
  render();
}
