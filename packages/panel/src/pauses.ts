// The Remove Pauses tab: the speech track (or its In/Out part) is exported alone, the companion listens to it
// with a local voice activity model (pauses-find) and answers the cuts for a tightness on the slider
// (pauses.cuts, pure maths, asked again on every move). The cut is applied by the host into a new sequence;
// the editor's own sequence is never edited, so undo is closing the new one.
import type { ServerMessage } from "./companion-session";
import { frameCuts } from "./cut-plan";
import type { CutSequenceResult, Host, HostSequence, TimelineCut } from "./host";
import { t } from "./i18n";
import { readableJobText } from "./job-errors";
import { formatDuration, formatTimecode, type Range } from "./range";

export type PausesStage = "idle" | "track" | "listening" | "preview" | "applying" | "done";

export interface PausesPlan {
  /** Seconds from the start of the part listened to. */
  cuts: TimelineCut[];
  removedS: number;
  keptS: number;
  longKept: TimelineCut[];
  /** The guard refused: the cuts would have left almost nothing. */
  emptied: boolean;
}

export interface PausesState {
  stage: PausesStage;
  error: string | null;
  /** Resolve could not put its Deliver settings back after the export. */
  settingsNote: string | null;
  /** The other audio tracks could not be switched off for the export. */
  notIsolated: boolean;
  last: string;
  jobId: string | null;
  jobDir: string | null;
  seqId: string | null;
  seqName: string;
  seqEndS: number;
  /** The sequence's frame rate: every host snaps the cuts to its frames, and so does the preview. */
  fps: number;
  /** Track counts at Find: a different count at Create means the sequence changed. */
  tracksSeen: { video: number; audio: number } | null;
  scope: "all" | "range";
  /** Where the part listened to starts in the sequence: the plan's times count from here. */
  rangeStartS: number;
  rangeEndS: number;
  tracks: number[];
  track: number | null;
  speech: [number, number][] | null;
  durationS: number;
  /** 0 Gentle .. 1 Tight; remembered per sequence. */
  strictness: number;
  plan: PausesPlan | null;
  progress: { done: number; total: number } | null;
  result: CutSequenceResult | null;
  /** This Find's token: Stop takes a new one, so a late export or job reply of the stopped run is ignored. */
  run: number;
}

export function newPauses(): PausesState {
  return {
    stage: "idle",
    error: null,
    settingsNote: null,
    notIsolated: false,
    last: "",
    jobId: null,
    jobDir: null,
    seqId: null,
    seqName: "",
    seqEndS: 0,
    fps: 0,
    tracksSeen: null,
    scope: "all",
    rangeStartS: 0,
    rangeEndS: 0,
    tracks: [],
    track: null,
    speech: null,
    durationS: 0,
    strictness: 0.5,
    plan: null,
    progress: null,
    result: null,
    run: 0,
  };
}

/** What the tab needs from the rest of the panel. */
export interface PausesCtx {
  esc(s: string): string;
  reportLink(error: string): string;
  seg(name: string, value: string, options: [string, string][]): string;
  render(): void;
  trace(line: string): void;
  connected(): boolean;
  /** The sequence's In/Out range when it has one. */
  inOut(): Range | null;
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
  renderSettingsLost(): Promise<boolean>;
  stored(key: string): string | null;
  store(key: string, value: string): void;
  hostKind(): Host["kind"];
  /** Undefined in an editor that cannot cut yet. */
  cutToNewSequence?: Host["cutToNewSequence"];
}

/**
 * The new sequence's name: one "(No Pauses)" however often pauses are removed again, so a second pass on
 * "Talk (No Pauses)" makes "Talk (No Pauses) 2", not "Talk (No Pauses) (No Pauses)".
 */
export function cutName(seqName: string, suffix: string): string {
  const tail = ` (${suffix})`;
  const m = new RegExp(`^(.*)${tail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?: (\\d+))?$`).exec(
    seqName,
  );
  if (!m) return `${seqName}${tail}`;
  return `${m[1]}${tail} ${Number(m[2] ?? 1) + 1}`;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
let runs = 0;
const strictKey = (seqId: string) => `pauses-strict:${seqId}`;
/** Slider moves closer together than this send one request. */
const DEBOUNCE_MS = 80;

/** An older app refuses the new job and request as invalid: say which part to update. */
function readable(text: string, wrap: boolean): string {
  if (/^Invalid message/i.test(text)) return t("mismatch.app");
  return readableJobText(text) ?? (wrap ? t("pauses.failed", { message: text }) : text);
}

/** Whether the panel should keep reading the sequence for a new In/Out while this tab is open. */
export function pausesWatches(st: PausesState): boolean {
  return st.stage === "idle" || st.stage === "done";
}

/** The bar's parts, as percentages of the part listened to, left to right; they fill it. */
export function barSegments(
  plan: PausesPlan,
  durationS: number,
): { kind: "keep" | "cut"; left: number; width: number }[] {
  if (!(durationS > 0)) return [];
  const pct = (s: number) => (Math.min(Math.max(s, 0), durationS) / durationS) * 100;
  const out: { kind: "keep" | "cut"; left: number; width: number }[] = [];
  let at = 0;
  for (const c of [...plan.cuts].sort((a, b) => a.startS - b.startS)) {
    const a = Math.max(pct(c.startS), at);
    const b = pct(c.endS);
    if (b <= a) continue;
    if (a > at) out.push({ kind: "keep", left: at, width: a - at });
    out.push({ kind: "cut", left: a, width: b - a });
    at = b;
  }
  if (at < 100) out.push({ kind: "keep", left: at, width: 100 - at });
  return out;
}

/**
 * What the new sequence will really lose: the plan's cuts on the sequence's frame grid, as every host cuts
 * them (start up, end down, merged). The plan's own seconds promise about a frame per cut too much.
 */
export function previewTotals(st: PausesState): {
  count: number;
  removedS: number;
  afterS: number;
  /** The snapped cuts, in seconds of the part listened to (for the bar). */
  cuts: TimelineCut[];
} {
  const plan = st.plan;
  if (!plan) return { count: 0, removedS: 0, afterS: st.seqEndS, cuts: [] };
  const fps = st.fps;
  if (!(fps > 0)) {
    return {
      count: plan.cuts.length,
      removedS: plan.removedS,
      afterS: Math.max(0, st.seqEndS - plan.removedS),
      cuts: plan.cuts,
    };
  }
  const endF = Math.round(st.seqEndS * fps);
  const frames = frameCuts(
    plan.cuts.map((c) => ({ startS: c.startS + st.rangeStartS, endS: c.endS + st.rangeStartS })),
    fps,
    endF,
  );
  const removedF = frames.reduce((n, c) => n + c.endF - c.startF, 0);
  return {
    count: frames.length,
    removedS: removedF / fps,
    afterS: Math.max(0, endF - removedF) / fps,
    cuts: frames.map((c) => ({
      startS: c.startF / fps - st.rangeStartS,
      endS: c.endF / fps - st.rangeStartS,
    })),
  };
}

// ---------- view ----------

function errorBoxes(st: PausesState, ctx: PausesCtx): string {
  return (
    (st.error
      ? `<div class="box warn">${ctx.esc(st.error)}${ctx.reportLink(st.error)}</div>`
      : "") + (st.settingsNote ? `<div class="box warn">${ctx.esc(st.settingsNote)}</div>` : "")
  );
}

/** In a slot of its own, so the slider's moves can set or clear it in place. */
function errors(st: PausesState, ctx: PausesCtx): string {
  return `<div id="pauses-errors">${errorBoxes(st, ctx)}</div>`;
}

export function pausesBox(st: PausesState, ctx: PausesCtx): string {
  const err = errors(st, ctx);
  switch (st.stage) {
    case "track":
      return `${err}<div class="note">${t("pauses.pickTrack")}</div>
  <div class="pbtns mt">${st.tracks
    .map(
      (n) =>
        `<div class="pbtn" data-act="pauses-track" data-val="${n}">${t("pauses.trackN", { n: n + 1 })}</div>`,
    )
    .join("")}</div>
  <div class="link mt" data-act="pauses-again">${t("pauses.again")}</div>`;
    case "listening":
      return `${err}<div class="box"><div class="row"><span>${t("pauses.listening")}</span></div>${
        st.last ? `<div class="small muted mt">${ctx.esc(st.last)}</div>` : ""
      }<div class="link mt" data-act="pauses-stop">${t("progress.stop")}</div></div>`;
    case "preview":
      return err + previewScreen(st, ctx);
    case "applying": {
      // no Stop: a half built sequence is the host's to clean up, not the editor's
      const p = st.progress;
      return `${err}<div class="box"><div class="row"><span>${
        p ? t("pauses.applying", { done: p.done, total: p.total }) : t("pauses.building")
      }</span></div></div>`;
    }
    case "done":
      return err + doneScreen(st, ctx);
    default:
      return err + idleScreen(st, ctx);
  }
}

/** The part listened to: the In/Out when the sequence has one, else the whole sequence (no choice to make). */
function idleScreen(_st: PausesState, ctx: PausesCtx): string {
  const can = Boolean(ctx.cutToNewSequence);
  return `<div class="note muted">${t("pauses.intro")}</div>
  ${can ? "" : `<div class="box warn">${t("pauses.unsupported")}</div>`}
  ${ctx.rangeLine()}
  ${can ? `<div class="btn mt${ctx.connected() ? "" : " off"}" data-act="pauses-find">${t("pauses.find")}</div>` : ""}`;
}

/** The summary and the bar: redrawn alone while the slider moves, so the drag is not cut short. */
function liveHtml(st: PausesState): string {
  const plan = st.plan;
  if (!plan) return `<div class="small muted mt">…</div>`;
  if (plan.emptied) return `<div class="box warn">${t("pauses.emptied")}</div>`;
  const totals = previewTotals(st);
  if (!totals.count) return `<div class="note muted">${t("pauses.none")}</div>`;
  // whole seconds on both sides, so "A becomes B" agrees with "N s shorter"
  const before = Math.round(st.seqEndS);
  const bar = barSegments({ ...plan, cuts: totals.cuts }, st.durationS)
    .map((p) => `<div class="pause-${p.kind}" style="width:${p.width.toFixed(3)}%"></div>`)
    .join("");
  return `<div class="pause-bar mt">${bar}</div>
  <div class="note">${t("pauses.summary", {
    n: totals.count,
    removed: formatDuration(totals.removedS),
    before: formatTimecode(before),
    after: formatTimecode(Math.max(0, before - Math.round(totals.removedS))),
  })}</div>`;
}

function canApply(st: PausesState): boolean {
  return Boolean(st.plan && !st.plan.emptied && previewTotals(st).count);
}

function previewScreen(st: PausesState, ctx: PausesCtx): string {
  const value = Math.round(st.strictness * 100);
  return `<div class="lbl">${t("pauses.strictness")}</div>
  <input class="pause-slider" id="pauses-strict" type="range" min="0" max="100" step="5" value="${value}">
  <div class="row small muted"><span>${t("pauses.gentle")}</span><span>${t("pauses.tight")}</span></div>
  <div id="pauses-live">${liveHtml(st)}</div>
  ${st.notIsolated ? `<div class="box warn">${t("pauses.notIsolated")}</div>` : ""}
  ${ctx.hostKind() === "resolve" ? `<div class="note muted">${t("pauses.rebuildNote")}</div>` : ""}
  <div id="pauses-apply-slot">${applyButton(st)}</div>
  <div class="link mt" data-act="pauses-again">${t("pauses.again")}</div>`;
}

function applyButton(st: PausesState): string {
  return canApply(st)
    ? `<div class="btn mt" data-act="pauses-apply">${t("pauses.apply")}</div>`
    : "";
}

function doneScreen(st: PausesState, ctx: PausesCtx): string {
  const r = st.result;
  if (!r) return idleScreen(st, ctx);
  return `<div class="box ok">${t("pauses.done", { name: ctx.esc(r.name) })}</div>
  ${r.leftOut > 0 ? `<div class="box warn">${t("pauses.leftOut", { n: r.leftOut })}</div>` : ""}
  ${r.rebuilt ? `<div class="note muted">${t("pauses.rebuildNote")}</div>` : ""}
  <div class="btn mt" data-act="pauses-again">${t("pauses.again")}</div>`;
}

/** Redraws the summary, bar and button in place; a full render would end the slider's drag. */
function renderLive(st: PausesState, ctx: PausesCtx): void {
  const doc = typeof document === "undefined" ? null : document;
  const live = doc?.getElementById("pauses-live");
  const slot = doc?.getElementById("pauses-apply-slot");
  const errorSlot = doc?.getElementById("pauses-errors");
  if (!live || !slot || !errorSlot) return ctx.render();
  // an error (a lost connection) shows, and clears on the next good answer, without ending the drag
  errorSlot.innerHTML = errorBoxes(st, ctx);
  live.innerHTML = liveHtml(st);
  slot.innerHTML = applyButton(st);
}

// ---------- actions ----------

/** Find Pauses: the sequence, then the speech track (asked when there are several), then the listening. */
async function find(st: PausesState, ctx: PausesCtx): Promise<void> {
  if (st.stage !== "idle" && st.stage !== "done") return;
  if (!ctx.cutToNewSequence) {
    st.error = t("pauses.unsupported");
    return ctx.render();
  }
  const range = ctx.inOut();
  const scope = range ? "range" : "all";
  Object.assign(st, newPauses(), { scope, stage: "listening", run: ++runs });
  const run = st.run;
  ctx.render();
  try {
    const target = await ctx.readSequence();
    if (st.run !== run) return;
    if (!target) {
      st.stage = "idle";
      return ctx.render();
    }
    st.seqId = target.id;
    st.seqName = target.name;
    st.seqEndS = target.endSeconds;
    st.fps = target.fpsValue;
    st.tracksSeen = { video: target.videoTracks, audio: target.audioTracks };
    st.rangeStartS = scope === "range" && range ? range.startS : 0;
    st.rangeEndS = scope === "range" && range ? range.endS : target.endSeconds;
    const saved = Number(ctx.stored(strictKey(target.id)));
    if (ctx.stored(strictKey(target.id)) !== null && saved >= 0 && saved <= 1)
      st.strictness = saved;
    const tracks = await ctx.speechTracksAt(target, st.rangeStartS, st.rangeEndS);
    if (st.run !== run) return;
    if (!tracks.length) {
      st.stage = "idle";
      st.error = t("pauses.noTrack");
      return ctx.render();
    }
    if (tracks.length > 1) {
      st.tracks = tracks;
      st.stage = "track";
      return ctx.render();
    }
    await listen(st, ctx, target, tracks[0]!, run);
  } catch (err) {
    if (st.run !== run) return;
    st.stage = "idle";
    st.error = readable(message(err), true);
    ctx.render();
  }
}

async function pickTrack(st: PausesState, ctx: PausesCtx, track: number): Promise<void> {
  if (st.stage !== "track" || !st.tracks.includes(track)) return;
  st.stage = "listening";
  st.run = ++runs;
  const run = st.run;
  ctx.render();
  try {
    const target = await ctx.readSequence();
    if (st.run !== run) return;
    if (!target || target.id !== st.seqId) {
      st.stage = "idle";
      if (target) st.error = t("pauses.changed");
      return ctx.render();
    }
    await listen(st, ctx, target, track, run);
  } catch (err) {
    if (st.run !== run) return;
    st.stage = "idle";
    st.error = readable(message(err), true);
    ctx.render();
  }
}

/** Exports the part from the speech track alone and has the companion find the speech in it. */
async function listen(
  st: PausesState,
  ctx: PausesCtx,
  target: HostSequence,
  track: number,
  run: number,
): Promise<void> {
  st.track = track;
  st.stage = "listening";
  ctx.render();
  const prepared = await ctx.request(
    {
      type: "job.prepare",
      projectPath: target.projectPath,
      sequenceName: "Remove Pauses",
      ...(target.jobRoot ? { jobRoot: target.jobRoot } : {}),
    },
    "job.prepared",
  );
  if (st.run !== run) return;
  st.jobDir = String(prepared.jobDir);
  const file = `${st.jobDir}/export.wav`;
  let exported;
  try {
    exported = await ctx.withOnlyAudioTrack(target, track, () =>
      ctx.exportAudio(target, st.rangeStartS, st.rangeEndS, file),
    );
  } finally {
    // Resolve may lose its Deliver settings even when the export fails: read (and cleared) either way
    const lost = await ctx.renderSettingsLost();
    st.settingsNote = lost ? t("resolve.settingsLost") : null;
    if (lost && st.run !== run) ctx.render();
  }
  // stopped during the export (a long sequence takes a while): nothing is listened to
  if (st.run !== run) return;
  if (!exported.result.ok) throw new Error(t("job.exportFailed"));
  st.notIsolated = !exported.isolated;
  // Premiere writes the whole sequence: the written file starts at offsetSeconds in the sequence
  const offset = exported.result.offsetSeconds;
  await runJob(
    st,
    ctx,
    run,
    {
      kind: "pauses-find",
      audioPath: file,
      rangeStartS: Math.max(0, st.rangeStartS - offset),
      rangeEndS: st.rangeEndS - offset,
      outDir: `${st.jobDir}/pauses`,
    },
    (result) => {
      const speech = Array.isArray(result.speech) ? (result.speech as [number, number][]) : [];
      if (!speech.length) {
        st.stage = "idle";
        st.error = t("pauses.noSpeech");
        return;
      }
      st.speech = speech;
      st.durationS = Number(result.durationS ?? st.rangeEndS - st.rangeStartS);
      st.stage = "preview";
      void askCuts(st, ctx);
    },
  );
}

/** Starts the listening job and follows it; `onDone` gets its result. */
async function runJob(
  st: PausesState,
  ctx: PausesCtx,
  run: number,
  params: Record<string, unknown>,
  onDone: (result: Record<string, unknown>) => void,
): Promise<void> {
  st.error = null;
  st.last = "";
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
      ctx.trace(`remove pauses: failed ${text}`);
      st.stage = "idle";
      st.error = m.type === "job.cancelled" ? t("job.stopped") : readable(text, true);
      ctx.render();
    }
  });
  try {
    const accepted = await ctx.request(
      { type: "job.start", ref: String(Date.now()), params },
      "job.accepted",
    );
    if (st.run !== run) {
      // Stop came while the job was being started: stop it now that it has an id
      off();
      ctx.send({ type: "job.cancel", jobId: String(accepted.jobId) });
      return;
    }
    st.jobId = String(accepted.jobId);
    ctx.render();
  } catch (err) {
    off();
    if (st.run !== run) return;
    st.stage = "idle";
    st.error = readable(message(err), true);
    ctx.render();
  }
}

/** Counts the cut requests: a reply to an older slider position is dropped. */
let asked = 0;

/** The cuts for the slider's tightness, from the companion (one implementation of the curves). */
async function askCuts(st: PausesState, ctx: PausesCtx): Promise<void> {
  if (!st.speech) return;
  const mine = ++asked;
  try {
    const reply = await ctx.request(
      {
        type: "pauses.cuts",
        speech: st.speech,
        durationS: st.durationS,
        strictness: st.strictness,
        // long silent parts are cut like any pause (decided for v1: no keep rule)
        keepLongS: null,
        // an In/Out part may begin or end mid word: keep a pad at its edges too
        ...(st.scope === "range" ? { rangeEdges: true } : {}),
      },
      "pauses.cuts",
    );
    if (mine !== asked || st.stage !== "preview") return;
    st.error = null;
    st.plan = {
      cuts: (reply.cuts as TimelineCut[] | undefined) ?? [],
      removedS: Number(reply.removedS ?? 0),
      keptS: Number(reply.keptS ?? 0),
      longKept: (reply.longKept as TimelineCut[] | undefined) ?? [],
      emptied: Boolean(reply.emptied),
    };
  } catch (err) {
    if (mine !== asked) return;
    st.error = readable(message(err), true);
  }
  renderLive(st, ctx);
}

let strictTimer: ReturnType<typeof setTimeout> | null = null;

function strictMoved(st: PausesState, ctx: PausesCtx, val: string): void {
  const v = Number(val);
  if (st.stage !== "preview" || !Number.isFinite(v)) return;
  // the slider gives 0..100; 0..1 is accepted too
  st.strictness = Math.min(1, Math.max(0, v > 1 ? v / 100 : v));
  if (st.seqId) ctx.store(strictKey(st.seqId), String(st.strictness));
  if (strictTimer) clearTimeout(strictTimer);
  strictTimer = setTimeout(() => {
    strictTimer = null;
    void askCuts(st, ctx);
  }, DEBOUNCE_MS);
}

/** Create Sequence Without Pauses: only on the sequence as it was at Find. */
async function apply(st: PausesState, ctx: PausesCtx): Promise<void> {
  const cut = ctx.cutToNewSequence;
  if (st.stage !== "preview" || !st.plan || !canApply(st) || !cut) return;
  // busy before the first wait: a second click must not build a second sequence
  st.stage = "applying";
  st.error = null;
  st.progress = null;
  ctx.render();
  try {
    const target = await ctx.readSequence();
    const seen = st.tracksSeen;
    if (
      !target ||
      target.id !== st.seqId ||
      Math.abs(target.endSeconds - st.seqEndS) > 1e-3 ||
      !seen ||
      target.videoTracks !== seen.video ||
      target.audioTracks !== seen.audio
    ) {
      Object.assign(st, { stage: "idle", plan: null, speech: null });
      st.error = t("pauses.changed");
      return ctx.render();
    }
    // the plan counts from the part listened to; the host cuts in sequence seconds
    const cuts = st.plan.cuts.map((c) => ({
      startS: c.startS + st.rangeStartS,
      endS: c.endS + st.rangeStartS,
    }));
    const name = cutName(st.seqName, t("pauses.suffix"));
    const result = await cut(target, cuts, name, (done, total) => {
      st.progress = { done, total };
      ctx.render();
    });
    ctx.trace(
      `remove pauses: ${cuts.length} cuts into "${result.name}", left out ${result.leftOut}`,
    );
    st.result = result;
    st.stage = "done";
  } catch (err) {
    // the host's reason (which clip, which frames) rides in `cause`: the log keeps it for a report
    const cause = err instanceof Error && err.cause !== undefined ? ` (${message(err.cause)})` : "";
    ctx.trace(`remove pauses: apply failed ${message(err)}${cause}`);
    st.stage = "preview";
    st.error = t("pauses.failed", { message: message(err) });
  }
  ctx.render();
}

const ACTS = new Set([
  "pauses-find",
  "pauses-track",
  "pauses-strict",
  "pauses-apply",
  "pauses-again",
  "pauses-stop",
]);

/** The tab's clicks (and the slider's moves). Returns true when it handled `act`. */
export function pausesAct(st: PausesState, ctx: PausesCtx, act: string, val = ""): boolean {
  if (!ACTS.has(act)) return false;
  if (act === "pauses-find") void find(st, ctx);
  else if (act === "pauses-track") void pickTrack(st, ctx, Number(val));
  else if (act === "pauses-strict") strictMoved(st, ctx, val);
  else if (act === "pauses-apply") void apply(st, ctx);
  else if (act === "pauses-stop") {
    if (st.jobId) ctx.send({ type: "job.cancel", jobId: st.jobId });
    else if (st.stage === "listening") {
      // before the job: the export (or the reading before it) cannot be called back, so this run is let go
      // and its late result ignored
      st.run = ++runs;
      st.stage = "idle";
      st.error = t("job.stopped");
    }
  } else if (act === "pauses-again" && st.stage !== "listening" && st.stage !== "applying") {
    Object.assign(st, newPauses());
  }
  return true;
}
