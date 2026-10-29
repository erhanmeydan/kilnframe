// The Music tab: the whole timeline or the In/Out range scored with Lyria in sections. Step one asks the
// companion for a plan (music-plan), which the editor reviews; step two makes the music (music-make), which the
// editor listens to section by section, makes again where needed, and places on a new audio track.
import type { ServerMessage } from "./companion-session";
import { formatUsd } from "./cost";
import type { HostSequence } from "./host";
import { lang, t } from "./i18n";
import { readableJobText } from "./job-errors";
import type { Range } from "./range";

export interface MusicSection {
  id: string;
  title: string;
  startS: number;
  endS: number;
  mood: string;
  energy: number;
  tempo: number;
  prompt: string;
  transitionOut?: "crossfade" | "end" | undefined;
  silent?: boolean | undefined;
  final?: boolean | undefined;
}
export interface MusicPlan {
  version: 1;
  world: string;
  sections: MusicSection[];
}
export interface MadeSection {
  id: string;
  file: string | null;
  clean: string | null;
  preview: string | null;
  atS: number;
  durationS: number;
  measured: { speechDb: number | null; gapDb: number | null };
  error?: string;
}

export interface MusicState {
  scope: "all" | "range";
  note: string;
  stage: "idle" | "planning" | "plan" | "making" | "listen" | "placing" | "done";
  last: string;
  jobId: string | null;
  jobDir: string | null;
  /** Where the range starts in the sequence: clips are placed from here. */
  rangeStartS: number;
  durationS: number;
  speechFile: string | null;
  plan: MusicPlan | null;
  /** Notes per section the editor wrote on the plan or for a remake; sent with the next make. */
  edits: Record<string, string>;
  made: MadeSection[] | null;
  spent: number;
  playing: string | null;
  error: string | null;
  /** Resolve could not put its Deliver settings back after the export: said next to the plan. */
  settingsNote: string | null;
  placedTrack: number | null;
}

export function newMusic(): MusicState {
  return {
    scope: "all",
    note: "",
    stage: "idle",
    last: "",
    jobId: null,
    jobDir: null,
    rangeStartS: 0,
    durationS: 0,
    speechFile: null,
    plan: null,
    edits: {},
    made: null,
    spent: 0,
    playing: null,
    error: null,
    settingsNote: null,
    placedTrack: null,
  };
}

export function planCost(plan: MusicPlan, pricePerSong: number): number {
  return plan.sections.filter((s) => !s.silent).length * pricePerSong;
}

export function toggleSilent(plan: MusicPlan, id: string): MusicPlan {
  return {
    ...plan,
    sections: plan.sections.map((s) => (s.id === id ? { ...s, silent: !s.silent } : s)),
  };
}

export function mergeWithNext(plan: MusicPlan, id: string): MusicPlan {
  const i = plan.sections.findIndex((s) => s.id === id);
  const next = plan.sections[i + 1];
  if (i < 0 || !next) return plan;
  const merged: MusicSection = { ...plan.sections[i]!, endS: next.endS };
  // the joined section ends the way the later one did
  delete merged.transitionOut;
  delete merged.final;
  if (next.transitionOut) merged.transitionOut = next.transitionOut;
  if (next.final) merged.final = true;
  const sections = [...plan.sections.slice(0, i), merged, ...plan.sections.slice(i + 2)];
  return { ...plan, sections: sections.map((s, k) => ({ ...s, id: `s${k + 1}` })) };
}

/** The measured levels as the listen screen shows them; `warn` when one misses its target by over 1.5 dB. */
export function levelNote(
  m: MadeSection,
  slider: number,
): { speech: string | null; gap: string | null; warn: boolean } {
  const { speechDb, gapDb } = m.measured;
  const off = (v: number | null, want: number) => v !== null && Math.abs(v - want) > 1.5;
  return {
    speech: speechDb === null ? null : speechDb.toFixed(1),
    gap: gapDb === null ? null : gapDb.toFixed(1),
    warn: off(speechDb, slider) || off(gapDb, slider + 6),
  };
}

/** The measured levels as one line; a level that could not be measured (no pauses, no speech) is left out. */
export function levelText(lv: { speech: string | null; gap: string | null }): string {
  if (lv.speech !== null && lv.gap !== null)
    return t("music.levels", { speech: lv.speech, gap: lv.gap });
  if (lv.speech !== null) return t("music.levelsSpeech", { speech: lv.speech });
  if (lv.gap !== null) return t("music.levelsGap", { gap: lv.gap });
  return "";
}

/** What the music planner (the plan, a rewritten note) cost: nothing when it ran on the editor's plan. */
export function textSpend(r: { listPriceUsd?: unknown; billing?: unknown }): number {
  return r.billing === "plan" ? 0 : Number(r.listPriceUsd ?? 0);
}

/**
 * A make (or a remake) finished: the listen screen comes back, and the new files can be placed again. They go
 * on a new track; the track placed before stays as it was (its files are never written over).
 */
export function afterMake(
  st: MusicState,
  result: {
    sections: MadeSection[];
    priceUsd?: number;
    plan?: MusicPlan;
    textPriceUsd?: number;
    billing?: string;
  },
  noted: string[],
): void {
  st.made = result.sections;
  st.plan = result.plan ?? st.plan;
  st.spent +=
    Number(result.priceUsd ?? 0) +
    textSpend({ listPriceUsd: result.textPriceUsd, billing: result.billing });
  for (const id of noted) delete st.edits[id];
  st.placedTrack = null;
  st.stage = "listen";
}

/**
 * Whether the home screen should keep reading the sequence for a new In/Out: the range tab, and the Music and
 * Captions tabs on their first step (a plan or a text belongs to the range it was made for).
 */
export function watchesSequence(
  tab: string,
  musicStage: MusicState["stage"],
  captionsStage = "idle",
): boolean {
  return (
    tab === "range" ||
    (tab === "music" && musicStage === "idle") ||
    (tab === "captions" && captionsStage === "idle")
  );
}

export function clock(seconds: number): string {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** What the tab needs from the rest of the panel. */
export interface MusicCtx {
  esc(s: string): string;
  /** "Report This Error ↗" under an error. */
  reportLink(error: string): string;
  seg<T extends string>(name: string, value: T, options: [T, string][]): string;
  render(): void;
  trace(line: string): void;
  connected(): boolean;
  keySet(): boolean;
  /** The sequence's In/Out range when it has one. */
  inOut(): Range | null;
  readSequence(): Promise<HostSequence | null>;
  request(message: unknown, reply: string, timeoutMs?: number): Promise<ServerMessage>;
  send(message: unknown): void;
  on(listener: (m: ServerMessage) => void): () => void;
  wavPreset(): string;
  frames(
    target: HostSequence,
    range: Range,
    jobDir: string,
  ): Promise<{ path: string; atS: number }[]>;
  withoutOurInserts<T>(target: HostSequence, range: Range, fn: () => Promise<T>): Promise<T>;
  /** Resolve: true once after an export whose Deliver settings could not be put back. */
  renderSettingsLost(): Promise<boolean>;
  exportAudio(
    target: HostSequence,
    range: Range,
    file: string,
  ): Promise<{ ok: boolean; offsetSeconds: number }>;
  placeClips(
    target: HostSequence,
    clips: { file: string; atS: number; durationS: number }[],
  ): Promise<{ audioTrack: number }>;
  /** The range line shown above the choices, as on the range tab. */
  rangeLine(scope: "all" | "range"): string;
  slider(): number;
  pricePerSong(): number;
  openTerms(): void;
}

const turkish = () => lang() === "tr";

function fieldText(id: string): string | null {
  const el = document.getElementById(id) as HTMLTextAreaElement | HTMLInputElement | null;
  return el ? (el.value ?? "") : null;
}

/** Keeps what the editor typed across renders (UXP reports a field's value only once it was set). */
export function musicReadFields(st: MusicState): void {
  const note = fieldText("music-note");
  if (note !== null) st.note = note;
  const world = fieldText("music-world");
  if (world !== null && st.plan && world.trim()) st.plan = { ...st.plan, world: world.trim() };
  for (const s of st.plan?.sections ?? []) {
    const v = fieldText(`music-edit-${s.id}`);
    if (v !== null) st.edits[s.id] = v;
  }
}

export function musicWriteFields(st: MusicState): void {
  const set = (id: string, v: string) => {
    const el = document.getElementById(id) as HTMLTextAreaElement | HTMLInputElement | null;
    if (el) el.value = v;
  };
  set("music-note", st.note);
  if (st.plan) set("music-world", st.plan.world);
  for (const s of st.plan?.sections ?? []) set(`music-edit-${s.id}`, st.edits[s.id] ?? "");
}

function busyBox(st: MusicState): string {
  return `<div class="box"><div class="row"><span>${t(
    st.stage === "planning"
      ? "music.planning"
      : st.stage === "placing"
        ? "music.placing"
        : "music.making",
  )}</span></div>${st.last ? `<div class="small muted mt">${st.last}</div>` : ""}${
    st.jobId && st.stage !== "placing"
      ? `<div class="link mt" data-act="music-cancel">${t("progress.stop")}</div>`
      : ""
  }</div>`;
}

export function musicBox(st: MusicState, ctx: MusicCtx): string {
  const err =
    (st.error
      ? `<div class="box warn">${ctx.esc(st.error)}${ctx.reportLink(st.error)}</div>`
      : "") + (st.settingsNote ? `<div class="box warn">${ctx.esc(st.settingsNote)}</div>` : "");
  if (st.stage === "planning" || st.stage === "making" || st.stage === "placing")
    return `${err}${busyBox(st)}`;
  if (st.stage === "plan" && st.plan) return err + planScreen(st, ctx);
  if ((st.stage === "listen" || st.stage === "done") && st.made) return err + listenScreen(st, ctx);
  const range = ctx.inOut();
  const scopes: ["all" | "range", string][] = [["all", t("music.scopeAll")]];
  if (range) scopes.push(["range", t("music.scopeRange")]);
  const ready = ctx.connected();
  return `${err}
  ${ctx.rangeLine(range ? st.scope : "all")}
  <div class="lbl">${t("music.scope")}</div>
  ${ctx.seg("music-scope", range ? st.scope : "all", scopes)}
  <div class="lbl">${t("music.note")}</div>
  <textarea id="music-note" placeholder="${t("music.notePlaceholder")}"></textarea>
  ${ctx.keySet() ? "" : `<div class="box warn">${t("music.noKey")}</div>`}
  <div class="small muted mt">${t("music.licence")} <span class="link" data-act="music-terms">${t("music.terms")}</span></div>
  <div class="btn mt${ready ? "" : " off"}" data-act="music-plan">${t("music.plan")}</div>`;
}

function planScreen(st: MusicState, ctx: MusicCtx): string {
  const plan = st.plan!;
  const rows = plan.sections
    .map((s) => {
      const how = s.final
        ? t("music.final")
        : s.transitionOut === "end"
          ? t("music.end")
          : t("music.crossfade");
      return `<div class="box small${s.silent ? " muted" : ""}">
    <div class="row"><span><b>${clock(s.startS)} · ${clock(s.endS)}</b> ${ctx.esc(s.title)}</span><span class="muted">${s.silent ? t("music.silent") : how}</span></div>
    ${s.silent ? "" : `<div class="muted mt">${ctx.esc(s.mood)}</div><input class="img-note" id="music-edit-${s.id}" type="text" placeholder="${t("music.sectionNote")}">`}
    <div class="row2 mt"><div class="link" data-act="music-silent" data-val="${s.id}">${s.silent ? t("music.withMusic") : t("music.silent")}</div>${
      s.final
        ? ""
        : `<div class="link" data-act="music-merge" data-val="${s.id}">${t("music.merge")}</div>`
    }</div></div>`;
    })
    .join("");
  const n = plan.sections.filter((s) => !s.silent).length;
  return `<div class="lbl">${t("music.world")}</div>
  <input class="img-note" id="music-world" type="text">
  <div class="lbl">${t("music.sections")}</div>
  ${rows}
  <div class="small muted mt">${t("music.cost", { n, usd: formatUsd(planCost(plan, ctx.pricePerSong()), turkish()) })}</div>
  <div class="btn mt${ctx.keySet() ? "" : " off"}" data-act="music-make">${t("music.make")}</div>
  <div class="link mt" data-act="music-new">${t("music.newPlan")}</div>`;
}

function listenScreen(st: MusicState, ctx: MusicCtx): string {
  const plan = st.plan!;
  const rows = st
    .made!.map((m) => {
      const s = plan.sections.find((x) => x.id === m.id);
      if (!s || s.silent) return "";
      const head = `<div class="row"><span><b>${clock(s.startS)} · ${clock(s.endS)}</b> ${ctx.esc(s.title)}</span>`;
      if (!m.file)
        return `<div class="box small">${head}<span class="warn-text">${t("music.failed")}</span></div>
    <div class="link" data-act="music-redo" data-val="${m.id}">${t("music.redo")}</div></div>`;
      const lv = levelNote(m, ctx.slider());
      const levels =
        lv.speech !== null || lv.gap !== null
          ? `<div class="${lv.warn ? "warn-text" : "muted"} mt">${levelText(lv)}${lv.warn ? ` · ${t("music.levelWarn")}` : ""}</div>`
          : "";
      const playing = st.playing === m.id;
      return `<div class="box small">${head}<span class="link" data-act="${playing ? "music-stop" : "music-play"}" data-val="${m.id}">${playing ? t("music.stop") : t("music.play")}</span></div>
    ${levels}${m.error ? `<div class="warn-text mt">${t("music.redoFailed")}</div>` : ""}
    <input class="img-note" id="music-edit-${m.id}" type="text" placeholder="${t("music.sectionNote")}">
    <div class="link mt" data-act="music-redo" data-val="${m.id}">${t("music.redo")}</div></div>`;
    })
    .join("");
  const placed =
    st.placedTrack !== null
      ? `<div class="box ok">${t("music.placed", { a: st.placedTrack + 1 })}</div>`
      : "";
  return `${placed}<div class="lbl">${t("music.listen")}</div>
  ${rows}
  <div class="small muted mt">${t("music.spent", { usd: formatUsd(st.spent, turkish()) })}</div>
  ${st.placedTrack === null ? `<div class="btn mt" data-act="music-place">${t("music.place")}</div>` : ""}
  <div class="link mt" data-act="music-new">${t("music.newPlan")}</div>`;
}

/** Starts a companion job and follows it; `onDone` gets its result. */
async function musicJob(
  st: MusicState,
  ctx: MusicCtx,
  params: Record<string, unknown>,
  back: MusicState["stage"],
  onDone: (result: Record<string, unknown>) => void,
): Promise<void> {
  st.error = null;
  // no id from an earlier job while this one is being accepted
  st.jobId = null;
  const off = ctx.on((m) => {
    if (m.jobId !== st.jobId) return;
    if (m.type === "job.progress") {
      st.last = String(m.message);
      ctx.render();
    } else if (m.type === "job.done") {
      off();
      // the job is over: a later Stop must not aim at it
      st.jobId = null;
      onDone(m.result as Record<string, unknown>);
      ctx.render();
    } else if (m.type === "job.error" || m.type === "job.cancelled") {
      off();
      st.stage = back;
      st.jobId = null;
      // a stop keeps the finished sections: making again only makes the missing ones
      st.error =
        m.type === "job.cancelled"
          ? t("job.stopped")
          : (readableJobText(String(m.message ?? m.type)) ??
            t("music.jobFailed", { message: String(m.message ?? m.type) }));
      ctx.trace(`music: failed ${String(m.message ?? m.type)}`);
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
    st.error = t("music.jobFailed", { message: err instanceof Error ? err.message : String(err) });
    ctx.render();
  }
}

async function planMusic(st: MusicState, ctx: MusicCtx): Promise<void> {
  // busy before the first wait: a second click must not start a second export and model call
  if (st.stage !== "idle") return;
  st.stage = "planning";
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
  st.stage = "planning";
  st.last = "";
  st.settingsNote = null;
  st.made = null;
  st.edits = {};
  st.placedTrack = null;
  st.spent = 0;
  ctx.render();
  try {
    const prepared = await ctx.request(
      {
        type: "job.prepare",
        projectPath: target.projectPath,
        sequenceName: `${target.name} Music`,
        ...(target.jobRoot ? { jobRoot: target.jobRoot } : {}),
      },
      "job.prepared",
    );
    const jobDir = String(prepared.jobDir);
    const audioPath = `${jobDir}/sequence.wav`;
    // the editor's own speech: earlier Kilnframe inserts over the range are switched off for the export
    // Resolve may lose its Deliver settings even when the export fails: read (and cleared) either way
    let exported;
    try {
      exported = await ctx.withoutOurInserts(target, range, async () => ({
        audio: await ctx.exportAudio(target, range, audioPath),
        frames: await ctx.frames(target, range, jobDir).catch(() => []),
      }));
    } finally {
      st.settingsNote = (await ctx.renderSettingsLost()) ? t("resolve.settingsLost") : null;
    }
    const { audio, frames } = exported;
    if (!audio.ok) throw new Error(t("job.exportFailed"));
    st.jobDir = jobDir;
    st.rangeStartS = range.startS;
    st.durationS = range.durationS;
    await musicJob(
      st,
      ctx,
      {
        kind: "music-plan",
        audioPath,
        // the written file starts at offsetSeconds in the sequence
        rangeStartS: Math.max(0, range.startS - audio.offsetSeconds),
        rangeEndS: range.endS - audio.offsetSeconds,
        outDir: jobDir,
        language: lang(),
        ...(st.note.trim() ? { note: st.note.trim() } : {}),
        ...(frames.length ? { frames: frames.slice(0, 3) } : {}),
      },
      "idle",
      (result) => {
        st.plan = result.plan as MusicPlan;
        st.speechFile = result.speechFile ? String(result.speechFile) : null;
        st.spent += textSpend(result);
        st.stage = "plan";
      },
    );
  } catch (err) {
    st.stage = "idle";
    st.error = t("music.jobFailed", { message: err instanceof Error ? err.message : String(err) });
    ctx.render();
  }
}

async function makeMusic(st: MusicState, ctx: MusicCtx, only?: string[]): Promise<void> {
  if (!st.plan || !st.jobDir) return;
  const back = st.made ? "listen" : "plan";
  const notes = Object.fromEntries(
    Object.entries(st.edits)
      .map(([k, v]) => [k, v.trim()] as const)
      .filter(([k, v]) => v && (!only || only.includes(k))),
  );
  st.stage = "making";
  st.last = "";
  ctx.render();
  await musicJob(
    st,
    ctx,
    {
      kind: "music-make",
      plan: st.plan,
      outDir: st.jobDir,
      durationS: st.durationS,
      slider: ctx.slider(),
      ...(only ? { only } : {}),
      ...(Object.keys(notes).length ? { notes } : {}),
      ...(st.speechFile ? { speechFile: st.speechFile } : {}),
    },
    back,
    (result) =>
      afterMake(
        st,
        result as { sections: MadeSection[]; priceUsd?: number; plan?: MusicPlan },
        Object.keys(notes),
      ),
  );
}

async function placeMusic(st: MusicState, ctx: MusicCtx): Promise<void> {
  // busy before the first wait: a second click must not place the music on a second track
  if (st.stage !== "listen" || !st.made) return;
  st.stage = "placing";
  const target = await ctx.readSequence();
  if (!target) {
    st.stage = "listen";
    return ctx.render();
  }
  ctx.render();
  try {
    const placed = await ctx.placeClips(
      target,
      st.made
        .filter((m) => m.file)
        .map((m) => ({ file: m.file!, atS: st.rangeStartS + m.atS, durationS: m.durationS })),
    );
    st.placedTrack = placed.audioTrack;
    st.stage = "done";
  } catch (err) {
    st.stage = "listen";
    st.error = err instanceof Error ? err.message : String(err);
  }
  ctx.render();
}

/** The tab's clicks. Returns true when it handled `act`. */
/** The Music tab's own actions; any other (the settings' music-level) is the panel's. */
const MUSIC_ACTS = new Set([
  "music-scope",
  "music-cancel",
  "music-terms",
  "music-plan",
  "music-silent",
  "music-merge",
  "music-make",
  "music-redo",
  "music-play",
  "music-stop",
  "music-place",
  "music-new",
]);

export function musicAct(st: MusicState, ctx: MusicCtx, act: string, val: string): boolean {
  if (!MUSIC_ACTS.has(act)) return false;
  const plan = st.plan;
  if (act === "music-scope") st.scope = val === "range" ? "range" : "all";
  else if (act === "music-cancel") {
    if (st.jobId) ctx.send({ type: "job.cancel", jobId: st.jobId });
  } else if (act === "music-terms") ctx.openTerms();
  else if (act === "music-plan") void planMusic(st, ctx);
  else if (act === "music-silent" && plan) st.plan = toggleSilent(plan, val);
  else if (act === "music-merge" && plan) {
    st.plan = mergeWithNext(plan, val);
    st.edits = {};
  } else if (act === "music-make") void makeMusic(st, ctx);
  else if (act === "music-redo") void makeMusic(st, ctx, [val]);
  else if (act === "music-play") {
    const m = st.made?.find((x) => x.id === val);
    const file = m?.preview ?? m?.file;
    if (file) {
      st.playing = val;
      void ctx.request({ type: "audio.play", file }, "audio.played").catch((e: unknown) => {
        st.playing = null;
        ctx.trace(`music: play failed ${String(e)}`);
        ctx.render();
      });
    }
  } else if (act === "music-stop") {
    st.playing = null;
    ctx.send({ type: "speech.stop" });
  } else if (act === "music-place") void placeMusic(st, ctx);
  else if (act === "music-new") {
    Object.assign(st, newMusic(), { scope: st.scope, note: st.note });
  }
  return true;
}
