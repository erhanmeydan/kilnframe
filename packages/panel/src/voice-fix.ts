// The Voice Fix tab: the editor marks a mis-spoken part with In/Out, edits its words, and has them read in
// their own ElevenLabs voice clone. Step one exports the speech track alone and has the companion cut a window
// around the part and read it (voice-fix-read); a clone is made once per sequence and track, with the editor's
// consent; step two reads the text exactly as typed (voice-fix-say), and the take goes on a new audio track
// at In. The original clip is never touched.
import type { ServerMessage } from "./companion-session";
import { formatUsd } from "./cost";
import type { HostSequence } from "./host";
import { lang, t } from "./i18n";
import { readableJobText } from "./job-errors";
import { formatDuration, type Range } from "./range";

export type VoiceFixStage =
  "idle" | "track" | "reading" | "edit" | "consent" | "cloning" | "saying" | "listen" | "placed";

interface Span {
  startS: number;
  endS: number;
}

export interface VoiceFixState {
  stage: VoiceFixStage;
  /** Whether an ElevenLabs key is saved; null until the companion said. */
  keySet: boolean | null;
  error: string | null;
  /** Resolve could not put its Deliver settings back after the export. */
  settingsNote: string | null;
  last: string;
  jobId: string | null;
  jobDir: string | null;
  seqId: string | null;
  seqName: string;
  /** The sequence has video: the take will not match the mouth on camera. */
  hasVideo: boolean;
  /** The audio tracks with sound under the range, when the editor has to pick one. */
  tracks: number[];
  track: number | null;
  /** The part being fixed, in sequence seconds. */
  fixStartS: number;
  fixEndS: number;
  /** The window the companion cut (voice-fix/window.wav): the sample spans count from its start. */
  windowFile: string | null;
  /** The speech track could be heard alone in the export. */
  isolated: boolean;
  text: string;
  before: string;
  after: string;
  language: string;
  sample: { spans: Span[]; speechS: number } | null;
  /** Where the clone learns from: the speech around the part, or another part the editor marks. */
  source: "around" | "other";
  consent: boolean;
  /** The sample's file once it was cut to listen to. */
  sampleFile: string | null;
  sampleBusy: boolean;
  take: number;
  result: { file: string; durationS: number; priceUsd: number } | null;
  placing: boolean;
  playing: "take" | "sample" | null;
  placedTrack: number | null;
}

export function newVoiceFix(): VoiceFixState {
  return {
    stage: "idle",
    keySet: null,
    error: null,
    settingsNote: null,
    last: "",
    jobId: null,
    jobDir: null,
    seqId: null,
    seqName: "",
    hasVideo: false,
    tracks: [],
    track: null,
    fixStartS: 0,
    fixEndS: 0,
    windowFile: null,
    isolated: true,
    text: "",
    before: "",
    after: "",
    language: "",
    sample: null,
    source: "around",
    consent: false,
    sampleFile: null,
    sampleBusy: false,
    take: 0,
    result: null,
    placing: false,
    playing: null,
    placedTrack: null,
  };
}

/** Seconds of the recording around the part that are exported and read. */
const WINDOW_S = 180;
/** Spoken seconds a clone needs at least, and at most (core VOICE_SAMPLE_MAX_S). */
const CLONE_MIN_S = 30;
const CLONE_MAX_S = 180;

/** What the tab needs from the rest of the panel. */
export interface VoiceFixCtx {
  esc(s: string): string;
  reportLink(error: string): string;
  render(): void;
  trace(line: string): void;
  connected(): boolean;
  /** The sequence's In/Out range when it has one. */
  inOut(): Range | null;
  /** The In/Out line, as on the range tab. */
  rangeLine(): string;
  readSequence(): Promise<HostSequence | null>;
  request(message: unknown, reply: string, timeoutMs?: number): Promise<ServerMessage>;
  send(message: unknown): void;
  on(listener: (m: ServerMessage) => void): () => void;
  speechTracksAt(seq: HostSequence, startS: number, endS: number): Promise<number[]>;
  withOnlyAudioTrack<T>(
    seq: HostSequence,
    track: number,
    fn: () => Promise<T>,
  ): Promise<{ result: T; isolated: boolean }>;
  exportAudio(
    seq: HostSequence,
    startS: number,
    endS: number,
    file: string,
  ): Promise<{ ok: boolean; offsetSeconds: number }>;
  /** Resolve: true once after an export whose Deliver settings could not be put back. */
  renderSettingsLost(): Promise<boolean>;
  placeClips(
    seq: HostSequence,
    clips: { file: string; atS: number; durationS: number }[],
  ): Promise<{ audioTrack: number }>;
  stored(key: string): string | null;
  store(key: string, value: string): void;
  forget(key: string): void;
}

const turkish = () => lang() === "tr";
const outDir = (st: VoiceFixState) => `${st.jobDir}/voice-fix`;
const cloneKey = (st: VoiceFixState) => `voice-clone:${st.seqId}:${st.track}`;
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Whether the panel should keep reading the sequence for a new In/Out while this tab is open. */
export function voiceFixWatches(st: VoiceFixState): boolean {
  return (
    st.stage === "idle" ||
    st.stage === "placed" ||
    (st.stage === "consent" && st.source === "other")
  );
}

/** The tab was opened: whether an ElevenLabs key is saved comes with the voice list. */
export async function voiceFixOpened(st: VoiceFixState, ctx: VoiceFixCtx): Promise<void> {
  if (!ctx.connected()) return;
  try {
    const reply = await ctx.request(
      { type: "speech.voices", provider: "elevenlabs" },
      "voices",
      30_000,
    );
    st.keySet = Boolean(reply.keySet);
  } catch (err) {
    ctx.trace(`voice fix: no voice list ${message(err)}`);
  }
  ctx.render();
}

/** Keeps what the editor typed across renders (UXP reports a field's value only once it was set). */
export function voiceFixReadFields(st: VoiceFixState): void {
  const el = document.getElementById("voice-fix-text") as HTMLTextAreaElement | null;
  if (el) st.text = el.value ?? "";
}

export function voiceFixWriteFields(st: VoiceFixState): void {
  const el = document.getElementById("voice-fix-text") as HTMLTextAreaElement | null;
  if (el) el.value = st.text;
}

// ---------- view ----------

function check(act: string, on: boolean, text: string): string {
  return `<div class="check mt" data-act="${act}"><span class="box-mark${on ? " on" : ""}">${on ? "✓" : ""}</span><span>${text}</span></div>`;
}

function busy(st: VoiceFixState, text: string, stop: boolean): string {
  return `<div class="box"><div class="row"><span>${text}</span></div>${
    st.last ? `<div class="small muted mt">${st.last}</div>` : ""
  }${stop && st.jobId ? `<div class="link mt" data-act="fix-cancel">${t("progress.stop")}</div>` : ""}</div>`;
}

function recloneLink(st: VoiceFixState, ctx: VoiceFixCtx): string {
  return ctx.stored(cloneKey(st))
    ? `<div class="link mt" data-act="fix-reclone">${t("fix.reclone")}</div>`
    : "";
}

/** Gives up the fix in progress and returns to the first screen. */
const startOver = () => `<div class="link mt" data-act="fix-new">${t("fix.startOver")}</div>`;

export function voiceFixBox(st: VoiceFixState, ctx: VoiceFixCtx): string {
  const err =
    (st.error
      ? `<div class="box warn">${ctx.esc(st.error)}${ctx.reportLink(st.error)}</div>`
      : "") + (st.settingsNote ? `<div class="box warn">${ctx.esc(st.settingsNote)}</div>` : "");
  switch (st.stage) {
    case "reading":
      return err + busy(st, t("fix.reading"), true);
    case "cloning":
      return err + busy(st, t("fix.cloning"), false);
    case "saying":
      return err + busy(st, t("fix.saying"), true);
    case "track":
      return `${err}<div class="note">${t("fix.pickTrack")}</div>
  <div class="pbtns mt">${st.tracks
    .map((n) => `<div class="pbtn" data-act="fix-track" data-val="${n}">A${n + 1}</div>`)
    .join("")}</div>
  ${startOver()}`;
    case "edit":
      return err + editScreen(st, ctx);
    case "consent":
      return err + consentScreen(st, ctx);
    case "listen":
    case "placed":
      return err + listenScreen(st, ctx);
    default:
      return err + idleScreen(st, ctx);
  }
}

function idleScreen(st: VoiceFixState, ctx: VoiceFixCtx): string {
  const range = ctx.inOut();
  const ready = ctx.connected() && st.keySet !== false && range !== null;
  return `${ctx.rangeLine()}
  <div class="note muted">${t("fix.hint")}</div>
  ${st.keySet === false ? `<div class="box warn">${t("fix.noKey")}</div>` : ""}
  ${range ? "" : `<div class="box warn">${t("clone.needRange")}</div>`}
  <div class="btn mt${ready ? "" : " off"}" data-act="fix-go">${t("fix.go")}</div>`;
}

function editScreen(st: VoiceFixState, ctx: VoiceFixCtx): string {
  return `<div class="lbl">${t("fix.text")}</div>
  <textarea id="voice-fix-text"></textarea>
  <div class="note muted">${t("fix.exact")}</div>
  ${st.hasVideo ? `<div class="note muted">${t("fix.onCamera")}</div>` : ""}
  <div class="btn mt" data-act="fix-say">${t("fix.read")}</div>
  ${recloneLink(st, ctx)}
  ${startOver()}`;
}

function consentScreen(st: VoiceFixState, ctx: VoiceFixCtx): string {
  const short =
    st.sample && st.sample.speechS < CLONE_MIN_S
      ? `<div class="box warn">${t("fix.sampleShort", { n: Math.round(st.sample.speechS) })}</div>`
      : "";
  const other =
    st.source === "other"
      ? `${ctx.rangeLine()}<div class="note muted">${t("fix.otherHint")}</div>`
      : "";
  const sample = st.sampleBusy
    ? `<div class="small muted mt">${t("fix.sampleCutting")}</div>`
    : st.playing === "sample"
      ? `<div class="link mt" data-act="fix-stop">${t("fix.stop")}</div>`
      : `<div class="link mt" data-act="fix-sample">${t("fix.sample")}</div>`;
  return `<div class="lbl">${t("fix.cloneTitle")}</div>
  <div class="note">${t("fix.oneSpeaker")}</div>
  ${
    st.isolated
      ? `<div class="note muted">${t("fix.clean")}</div>`
      : `<div class="box warn">${t("fix.notIsolated")}</div>`
  }
  ${short}
  <div class="lbl">${t("fix.sampleFrom")}</div>
  <div class="seg"><div class="opt${st.source === "around" ? " on" : ""}" data-act="fix-source" data-val="around">${t("fix.around")}</div><div class="opt${st.source === "other" ? " on" : ""}" data-act="fix-source" data-val="other">${t("fix.other")}</div></div>
  ${other}
  ${sample}
  ${check("fix-consent", st.consent, t("clone.consent"))}
  <div class="btn mt" data-act="fix-clone">${t("fix.clone")}</div>
  <div class="link mt" data-act="fix-back">${t("fix.back")}</div>
  ${startOver()}`;
}

/** "0.4 s longer than the original", or as long. */
export function lengthNote(takeS: number, originalS: number): string {
  const d = takeS - originalS;
  const n = Math.abs(d).toFixed(1);
  if (n === "0.0") return t("fix.same");
  return t(d > 0 ? "fix.longer" : "fix.shorter", { n: turkish() ? n.replace(".", ",") : n });
}

function listenScreen(st: VoiceFixState, ctx: VoiceFixCtx): string {
  const r = st.result;
  if (!r) return idleScreen(st, ctx);
  const playing = st.playing === "take";
  const head = `<div class="box small"><div class="row"><span><b>${t("fix.take", { n: st.take })}</b></span><span class="link" data-act="${playing ? "fix-stop" : "fix-play"}">${playing ? t("fix.stop") : t("fix.play")}</span></div>
  <div class="muted mt">${lengthNote(r.durationS, st.fixEndS - st.fixStartS)} · ${t("fix.price", { usd: formatUsd(r.priceUsd, turkish()) })}</div></div>`;
  if (st.stage === "placed")
    return `${head}<div class="box ok">${t("fix.placed", { a: (st.placedTrack ?? 0) + 1 })}</div>
  <div class="btn mt" data-act="fix-new">${t("fix.another")}</div>
  ${recloneLink(st, ctx)}`;
  return `${head}
  <div class="pbtns mt"><div class="pbtn" data-act="fix-again">${t("fix.again")}</div><div class="pbtn primary${st.placing ? " off" : ""}" data-act="fix-place">${t("fix.place")}</div></div>
  ${recloneLink(st, ctx)}
  ${startOver()}`;
}

// ---------- actions ----------

/** Starts a companion job and follows it; `onDone` gets its result, `onError` may take over an error. */
async function fixJob(
  st: VoiceFixState,
  ctx: VoiceFixCtx,
  params: Record<string, unknown>,
  back: VoiceFixStage,
  onDone: (result: Record<string, unknown>) => void,
  onError?: (message: string) => boolean,
): Promise<void> {
  st.error = null;
  st.last = "";
  // no id from an earlier job while this one is being accepted
  st.jobId = null;
  const off = ctx.on((m) => {
    if (m.jobId !== st.jobId) return;
    if (m.type === "job.progress") {
      st.last = String(m.message);
      ctx.render();
    } else if (m.type === "job.done") {
      off();
      st.jobId = null;
      onDone(m.result as Record<string, unknown>);
      ctx.render();
    } else if (m.type === "job.error" || m.type === "job.cancelled") {
      off();
      st.jobId = null;
      const text = String(m.message ?? m.type);
      ctx.trace(`voice fix: failed ${text}`);
      if (m.type === "job.error" && onError?.(text)) return ctx.render();
      st.stage = back;
      st.error =
        m.type === "job.cancelled"
          ? t("job.stopped")
          : (readableJobText(text) ?? t("fix.failed", { message: text }));
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
    st.error = t("fix.failed", { message: message(err) });
    ctx.render();
  }
}

/** Fix This Part: the range, then the speech track (asked when there are several), then the read. */
async function start(st: VoiceFixState, ctx: VoiceFixCtx): Promise<void> {
  if (st.stage !== "idle" && st.stage !== "placed") return;
  const range = ctx.inOut();
  if (!range) {
    st.error = t("clone.needRange");
    return ctx.render();
  }
  if (st.keySet === false) {
    st.error = t("fix.noKey");
    return ctx.render();
  }
  const keySet = st.keySet;
  Object.assign(st, newVoiceFix(), { keySet, stage: "reading" });
  ctx.render();
  try {
    const target = await ctx.readSequence();
    if (!target) {
      st.stage = "idle";
      return ctx.render();
    }
    st.seqId = target.id;
    st.seqName = target.name;
    st.hasVideo = target.videoTracks > 0;
    st.fixStartS = range.startS;
    st.fixEndS = range.endS;
    const tracks = await ctx.speechTracksAt(target, range.startS, range.endS);
    if (!tracks.length) {
      st.stage = "idle";
      st.error = t("fix.noTrack");
      return ctx.render();
    }
    if (tracks.length > 1) {
      st.tracks = tracks;
      st.stage = "track";
      return ctx.render();
    }
    await readWindow(st, ctx, target, tracks[0]!);
  } catch (err) {
    st.stage = "idle";
    st.error = t("fix.failed", { message: message(err) });
    ctx.render();
  }
}

async function pickTrack(st: VoiceFixState, ctx: VoiceFixCtx, track: number): Promise<void> {
  if (st.stage !== "track" || !st.tracks.includes(track)) return;
  st.stage = "reading";
  ctx.render();
  try {
    const target = await ctx.readSequence();
    if (!target || target.id !== st.seqId) {
      st.stage = "idle";
      if (target) st.error = t("fix.otherSequence");
      return ctx.render();
    }
    await readWindow(st, ctx, target, track);
  } catch (err) {
    st.stage = "idle";
    st.error = t("fix.failed", { message: message(err) });
    ctx.render();
  }
}

/** Exports the window around the part from the speech track alone and has the companion read it. */
async function readWindow(
  st: VoiceFixState,
  ctx: VoiceFixCtx,
  target: HostSequence,
  track: number,
): Promise<void> {
  st.track = track;
  st.stage = "reading";
  ctx.render();
  const prepared = await ctx.request(
    {
      type: "job.prepare",
      projectPath: target.projectPath,
      sequenceName: "Voice Fix",
      ...(target.jobRoot ? { jobRoot: target.jobRoot } : {}),
    },
    "job.prepared",
  );
  st.jobDir = String(prepared.jobDir);
  // into the job folder, which exists: the companion cuts the window into voice-fix/ and reads only that
  const file = `${st.jobDir}/export.wav`;
  const fromS = Math.max(0, st.fixStartS - WINDOW_S);
  const toS = Math.min(target.endSeconds, st.fixEndS + WINDOW_S);
  let exported;
  try {
    exported = await ctx.withOnlyAudioTrack(target, track, () =>
      ctx.exportAudio(target, fromS, toS, file),
    );
  } finally {
    // Resolve may lose its Deliver settings even when the export fails: read (and cleared) either way
    st.settingsNote = (await ctx.renderSettingsLost()) ? t("resolve.settingsLost") : null;
  }
  if (!exported.result.ok) throw new Error(t("job.exportFailed"));
  st.isolated = exported.isolated;
  const offset = exported.result.offsetSeconds;
  await fixJob(
    st,
    ctx,
    {
      kind: "voice-fix-read",
      audioPath: file,
      // the written file starts at offsetSeconds in the sequence
      fixStartS: Math.max(0, st.fixStartS - offset),
      fixEndS: st.fixEndS - offset,
      windowStartS: Math.max(0, fromS - offset),
      windowEndS: toS - offset,
      outDir: outDir(st),
    },
    "idle",
    (result) => {
      st.text = String(result.text ?? "");
      st.before = String(result.before ?? "");
      st.after = String(result.after ?? "");
      st.language = String(result.language ?? "");
      st.sample = (result.sample as VoiceFixState["sample"]) ?? null;
      // the sample spans count from the window the companion cut
      st.windowFile = result.windowPath ? String(result.windowPath) : null;
      st.stage = "edit";
    },
  );
}

/** Read In My Voice: with a remembered clone straight to the take, else the consent screen first. */
function read(st: VoiceFixState, ctx: VoiceFixCtx): void {
  if (st.stage !== "edit") return;
  if (!st.text.trim()) {
    st.error = t("fix.emptyText");
    return ctx.render();
  }
  st.error = null;
  const voice = ctx.stored(cloneKey(st));
  if (voice) return void say(st, ctx, voice);
  toConsent(st);
  ctx.render();
}

function toConsent(st: VoiceFixState): void {
  st.stage = "consent";
  st.consent = false;
  st.sampleFile = null;
  // too little speech around the part: the editor marks another part instead
  if (st.sample && st.sample.speechS < CLONE_MIN_S) st.source = "other";
}

/** The text exactly as typed, read in the clone; each read is a new numbered take. */
async function say(st: VoiceFixState, ctx: VoiceFixCtx, voice: string): Promise<void> {
  st.stage = "saying";
  st.take += 1;
  st.playing = null;
  ctx.render();
  await fixJob(
    st,
    ctx,
    {
      kind: "voice-fix-say",
      text: st.text,
      voice,
      ...(st.before ? { before: st.before.slice(-2000) } : {}),
      ...(st.after ? { after: st.after.slice(0, 2000) } : {}),
      ...(st.language ? { language: st.language.slice(0, 10) } : {}),
      outDir: outDir(st),
      take: st.take,
    },
    "edit",
    (result) => {
      st.result = {
        file: String(result.file),
        durationS: Number(result.durationS ?? 0),
        priceUsd: Number(result.priceUsd ?? 0),
      };
      st.placedTrack = null;
      st.stage = "listen";
    },
    (text) => {
      // the clone was deleted from the account: forget it and clone again
      if (!/could not find this voice/i.test(text)) return false;
      ctx.forget(cloneKey(st));
      toConsent(st);
      st.error = t("fix.voiceGone");
      return true;
    },
  );
}

/**
 * What speech.clone learns from: the spans around the part in the window already exported, or the other
 * part the editor marked, exported fresh from the same track. Null (with the error set) when not usable.
 */
async function cloneSource(
  st: VoiceFixState,
  ctx: VoiceFixCtx,
): Promise<Record<string, unknown> | null> {
  if (st.source === "around") {
    // too little speech around the part makes a poor clone: never sent, however often chosen
    const speechS = st.sample?.spans.length ? st.sample.speechS : 0;
    if (!st.windowFile || speechS < CLONE_MIN_S) {
      st.error = t("fix.sampleShort", { n: Math.round(speechS) });
      return null;
    }
    return { audioPath: st.windowFile, spans: st.sample!.spans };
  }
  const range = ctx.inOut();
  if (!range) {
    st.error = t("clone.needRange");
    return null;
  }
  // the part being fixed never goes in the sample
  if (range.startS < st.fixEndS && range.endS > st.fixStartS) {
    st.error = t("fix.otherOverlaps");
    return null;
  }
  if (range.durationS < CLONE_MIN_S) {
    st.error = t("clone.short", { duration: formatDuration(range.durationS) });
    return null;
  }
  const target = await ctx.readSequence();
  if (!target || target.id !== st.seqId || st.track === null) {
    st.error = t("fix.otherSequence");
    return null;
  }
  const track = st.track;
  // next to the job folder's export; the companion puts its sample in voice-fix/
  const file = `${st.jobDir}/other.wav`;
  const endS = Math.min(range.endS, range.startS + CLONE_MAX_S);
  let exported;
  try {
    exported = await ctx.withOnlyAudioTrack(target, track, () =>
      ctx.exportAudio(target, range.startS, endS, file),
    );
  } finally {
    st.settingsNote = (await ctx.renderSettingsLost()) ? t("resolve.settingsLost") : null;
  }
  if (!exported.result.ok) throw new Error(t("job.exportFailed"));
  st.isolated = exported.isolated;
  const offset = exported.result.offsetSeconds;
  return {
    audioPath: file,
    rangeStartS: Math.max(0, range.startS - offset),
    rangeEndS: endS - offset,
  };
}

function cloneName(st: VoiceFixState): string {
  return `Kilnframe: ${st.seqName}`.slice(0, 60);
}

/** Listen To Sample: the sample is cut (nothing is uploaded) and played. */
async function listenSample(st: VoiceFixState, ctx: VoiceFixCtx): Promise<void> {
  if (st.stage !== "consent" || st.sampleBusy) return;
  st.sampleBusy = true;
  st.error = null;
  ctx.render();
  try {
    const source = await cloneSource(st, ctx);
    if (!source) return;
    const reply = await ctx.request(
      {
        type: "speech.clone",
        ...source,
        name: cloneName(st),
        removeNoise: false,
        // only cut to listen to: nothing is uploaded, so no consent is sent yet
        dryRun: true,
      },
      "speech.cloned",
      180_000,
    );
    st.sampleFile = reply.sample ? String(reply.sample) : null;
    if (st.sampleFile) {
      st.playing = "sample";
      await ctx.request({ type: "audio.play", file: st.sampleFile }, "audio.played");
    }
  } catch (err) {
    st.playing = null;
    st.error = t("clone.failed", { message: message(err) });
  } finally {
    st.sampleBusy = false;
    ctx.render();
  }
}

/** Clone And Read: only with the editor's consent; the voice is remembered for this sequence and track. */
async function cloneAndRead(st: VoiceFixState, ctx: VoiceFixCtx): Promise<void> {
  if (st.stage !== "consent") return;
  if (!st.consent) {
    st.error = t("clone.needConsent");
    return ctx.render();
  }
  if (!st.text.trim()) {
    st.stage = "edit";
    st.error = t("fix.emptyText");
    return ctx.render();
  }
  st.stage = "cloning";
  st.error = null;
  ctx.render();
  let voice: string;
  try {
    const source = await cloneSource(st, ctx);
    if (!source) {
      st.stage = "consent";
      return ctx.render();
    }
    if (st.playing === "sample") ctx.send({ type: "speech.stop" });
    st.playing = null;
    const reply = await ctx.request(
      {
        type: "speech.clone",
        ...source,
        name: cloneName(st),
        removeNoise: false,
        consent: true,
      },
      "speech.cloned",
      180_000,
    );
    voice = String(reply.voice);
    ctx.trace(`voice fix: cloned ${voice} from ${String(reply.durationS)} s`);
    ctx.store(cloneKey(st), voice);
  } catch (err) {
    st.stage = "consent";
    st.error = t("clone.failed", { message: message(err) });
    return ctx.render();
  }
  await say(st, ctx, voice);
}

async function place(st: VoiceFixState, ctx: VoiceFixCtx): Promise<void> {
  // busy before the first wait: a second click must not place the take on a second track
  if (st.stage !== "listen" || !st.result || st.placing) return;
  st.placing = true;
  ctx.render();
  try {
    const target = await ctx.readSequence();
    if (!target || target.id !== st.seqId) {
      if (target) st.error = t("fix.otherSequence");
      return;
    }
    const placed = await ctx.placeClips(target, [
      { file: st.result.file, atS: st.fixStartS, durationS: st.result.durationS },
    ]);
    st.placedTrack = placed.audioTrack;
    st.stage = "placed";
    ctx.trace(
      `voice fix: placed ${st.result.durationS} s at ${st.fixStartS} s on audio track ${placed.audioTrack + 1}`,
    );
  } catch (err) {
    ctx.trace(`voice fix: place failed ${message(err)}`);
    st.error = message(err);
  } finally {
    st.placing = false;
    ctx.render();
  }
}

function play(st: VoiceFixState, ctx: VoiceFixCtx): void {
  const file = st.result?.file;
  if (!file) return;
  st.playing = "take";
  void ctx.request({ type: "audio.play", file }, "audio.played").catch((e: unknown) => {
    st.playing = null;
    ctx.trace(`voice fix: play failed ${String(e)}`);
    ctx.render();
  });
}

const FIX_ACTS = new Set([
  "fix-go",
  "fix-track",
  "fix-cancel",
  "fix-say",
  "fix-source",
  "fix-sample",
  "fix-consent",
  "fix-clone",
  "fix-back",
  "fix-play",
  "fix-stop",
  "fix-again",
  "fix-place",
  "fix-new",
  "fix-reclone",
]);

/** The tab's clicks. Returns true when it handled `act`. */
export function voiceFixAct(
  st: VoiceFixState,
  ctx: VoiceFixCtx,
  act: string,
  val: string,
): boolean {
  if (!FIX_ACTS.has(act)) return false;
  if (act === "fix-go") void start(st, ctx);
  else if (act === "fix-track") void pickTrack(st, ctx, Number(val));
  else if (act === "fix-cancel") {
    if (st.jobId) ctx.send({ type: "job.cancel", jobId: st.jobId });
  } else if (act === "fix-say") read(st, ctx);
  else if (act === "fix-source") {
    st.source = val === "other" ? "other" : "around";
    st.sampleFile = null;
    st.error = null;
  } else if (act === "fix-sample") void listenSample(st, ctx);
  else if (act === "fix-consent") st.consent = !st.consent;
  else if (act === "fix-clone") void cloneAndRead(st, ctx);
  else if (act === "fix-back" && st.stage === "consent") {
    st.stage = "edit";
    st.error = null;
  } else if (act === "fix-play") play(st, ctx);
  else if (act === "fix-stop") {
    st.playing = null;
    ctx.send({ type: "speech.stop" });
  } else if (act === "fix-again" && st.stage === "listen") {
    // back to the text as it was, to change it and read again
    st.stage = "edit";
    st.error = null;
  } else if (act === "fix-place") void place(st, ctx);
  else if (act === "fix-new") {
    if (st.playing) ctx.send({ type: "speech.stop" });
    Object.assign(st, newVoiceFix(), { keySet: st.keySet });
  } else if (act === "fix-reclone" && st.seqId !== null && st.track !== null) {
    ctx.forget(cloneKey(st));
    if (st.stage !== "placed") toConsent(st);
  }
  return true;
}
