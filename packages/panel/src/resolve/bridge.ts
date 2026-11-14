// Everything the panel asks of DaVinci Resolve Studio, through the Workflow Integration promise API (Resolve 20.1+).
// Runs in the panel's Electron main process; `resolve` is WorkflowIntegration.GetResolvePromise(), or a fake in
// tests. Behaviour measured on Resolve Studio 21.1.1:
// - Timeline.GetMarkInOut() is relative to the timeline start; renders and placement want absolute frames.
// - MediaPool.AppendToTimeline clears In/Out, moves the playhead, slides a clip off an occupied spot and places
//   nothing on a locked track while still returning the item: everything is read back and checked.
// - Rendering changes the Deliver page's settings and Resolve cannot report them: they are kept as a preset.
// - Renders, frame exports and appends act on the current timeline: the target is made current for them.
import {
  EXPORTS_STOPPED,
  NO_SEQUENCE,
  CUT_FAILED,
  PLACE_FAILED,
  RENDER_BUSY,
  RENDER_FAILED,
  UNSET_MARK,
  type HiddenTrack,
  type PlacedTracks,
  type ResolveBridge,
  type ResolveSequence,
} from "./api";
import { frameCuts, newEndF, piecesOf } from "../cut-plan";
import { frameFor, insertScale } from "../frame";
import { isOurAnimation, isOurInsert, isVoiceFixTake } from "../our-files";
import { framesToTimecode, parseRate, rateString, type Rate } from "./timecode";

/* eslint-disable @typescript-eslint/no-explicit-any -- Resolve's promise objects are untyped */
type R = any;

const TEMP_PRESET = "Kilnframe Temp";
const BUSY_WAIT_MS = 10 * 60_000;
const POLL_MS = 2_000;
const START_TRIES = 5;
const PAGE_SETTLE_MS = 500;
const READY_LIMIT_MS = 15_000;
/** Clip infos per AppendToTimeline call when a cut rebuilds a timeline. */
const CUT_BATCH = 200;

const dirOf = (p: string) => p.replace(/[\\/][^\\/]*$/, "");
const baseOf = (p: string) => p.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
/** True when two paths name the same file, whichever slashes and letter case a Windows path came with. */
const samePath = (a: string, b: string) => {
  const norm = (p: string) => (/^[a-z]:/i.test(p) ? p.replace(/\//g, "\\").toLowerCase() : p);
  return norm(a) === norm(b);
};

export function createResolveBridge(
  resolve: R,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): ResolveBridge {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));

  /** Counts the editor's stops: a wait that sees it change ends. */
  let stops = 0;

  /** The editor's page before a job's exports changed it; showTracks brings it back. */
  let pageBefore: string | null = null;

  /**
   * Resolve 21.1.1 answers true to SetTrackEnable on the Deliver page but leaves the track as it was (12 Oct
   * 2026), so tracks are hidden and shown elsewhere; an editor who started there gets the page back at the end.
   */
  async function leaveDeliver() {
    if ((await resolve.GetCurrentPage()) !== "deliver") return;
    pageBefore ??= "deliver";
    await resolve.OpenPage("edit");
  }

  /** Switches off the enabled tracks holding our inserts over [startS, endS); off the Deliver page. */
  function hideOn(id: string, startS: number, endS: number): Promise<HiddenTrack[]> {
    return onTimeline(id, async (tl) => {
      await leaveDeliver();
      const rate = await rateOf(tl);
      const start = (await tl.GetStartFrame()) as number;
      const from = start + Math.round(startS * rate.fps);
      const to = start + Math.round(endS * rate.fps);
      const hidden: HiddenTrack[] = [];
      for (const type of ["video", "audio"] as const) {
        const count = (await tl.GetTrackCount(type)) as number;
        for (let i = 1; i <= count; i++) {
          if (!(await tl.GetIsTrackEnabled(type, i))) continue;
          let ours = false;
          for (const item of ((await tl.GetItemListInTrack(type, i)) ?? []) as R[]) {
            if ((await item.GetEnd()) <= from || (await item.GetStart()) >= to) continue;
            const path = await pathOf(item);
            if (path && isOurInsert(path)) ours = true;
          }
          if (ours && (await tl.SetTrackEnable(type, i, false))) hidden.push({ type, index: i });
        }
      }
      return hidden;
    });
  }

  /** Switches off every enabled audio track but the 1-based `keep`; off the Deliver page. All or none. */
  /** Every audio track but the 1-based ones in `keep` off. */
  function soloOn(id: string, keep: Set<number>): Promise<HiddenTrack[]> {
    return onTimeline(id, async (tl) => {
      await leaveDeliver();
      const hidden: HiddenTrack[] = [];
      try {
        const count = (await tl.GetTrackCount("audio")) as number;
        for (let i = 1; i <= count; i++) {
          if (keep.has(i) || !(await tl.GetIsTrackEnabled("audio", i))) continue;
          // a refused switch would leave that track in the export: the switch fails as a whole
          if (!(await tl.SetTrackEnable("audio", i, false))) throw new Error(PLACE_FAILED);
          hidden.push({ type: "audio", index: i });
        }
      } catch (err) {
        // the caller never learns which tracks went off: they go back on here
        for (const t of hidden) await tl.SetTrackEnable(t.type, t.index, true).catch(() => false);
        throw err;
      }
      return hidden;
    });
  }

  async function project(): Promise<R> {
    const p = await (await resolve.GetProjectManager()).GetCurrentProject();
    if (!p) throw new Error(NO_SEQUENCE);
    return p;
  }

  async function rateOf(tl: R): Promise<Rate> {
    const s = (await tl.GetSetting()) as Record<string, string>;
    const df = s.timelineDropFrameTimecode === "1" ? " DF" : "";
    return parseRate(`${s.timelineFrameRate}${df}`);
  }

  /** The timeline with this id; NO_SEQUENCE when there is none. */
  async function findTimeline(p: R, id: string): Promise<R> {
    const count = await p.GetTimelineCount();
    for (let i = 1; i <= count; i++) {
      const tl = await p.GetTimelineByIndex(i);
      if (tl && (await tl.GetUniqueId()) === id) return tl;
    }
    throw new Error(NO_SEQUENCE);
  }

  /** The timeline with this id, made current for `fn`, the previous current one restored afterwards. */
  async function onTimeline<T>(id: string, fn: (tl: R, p: R) => Promise<T>): Promise<T> {
    const p = await project();
    const current = await p.GetCurrentTimeline();
    if (current && (await current.GetUniqueId()) === id) return fn(current, p);
    const tl = await findTimeline(p, id);
    await p.SetCurrentTimeline(tl);
    try {
      return await fn(tl, p);
    } finally {
      if (current) await p.SetCurrentTimeline(current);
    }
  }

  /** The range marks: the video ones when they say anything, else the audio ones. */
  function markOf(marks: Record<string, { in?: number; out?: number }>): {
    in?: number;
    out?: number;
  } {
    return marks.video?.in !== undefined || marks.video?.out !== undefined
      ? marks.video
      : (marks.audio ?? {});
  }

  /** Brings back the editor's page a job left, and forgets it. */
  async function restorePage() {
    const back = pageBefore;
    pageBefore = null;
    if (back && (await resolve.GetCurrentPage()) !== back) await resolve.OpenPage(back);
  }

  /** An export could not keep or put back the editor's render settings. */
  let settingsLost = false;

  async function describe(tl: R, p: R): Promise<ResolveSequence> {
    const s = (await tl.GetSetting()) as Record<string, string>;
    const rate = await rateOf(tl);
    const start = (await tl.GetStartFrame()) as number;
    const end = (await tl.GetEndFrame()) as number;
    const mark = markOf(await tl.GetMarkInOut());
    const length = end - start;
    return {
      id: await tl.GetUniqueId(),
      name: await tl.GetName(),
      projectName: await p.GetName(),
      fps: rateString(rate),
      fpsValue: rate.fps,
      width: Number(s.timelineResolutionWidth),
      height: Number(s.timelineResolutionHeight),
      startFrame: start,
      inSeconds: mark?.in !== undefined ? mark.in / rate.fps : UNSET_MARK,
      // Out is the last frame of the range, inclusive
      outSeconds: mark?.out !== undefined ? (mark.out + 1) / rate.fps : UNSET_MARK,
      endSeconds: length / rate.fps,
      videoTracks: await tl.GetTrackCount("video"),
      audioTracks: await tl.GetTrackCount("audio"),
    };
  }

  /** Renders [startS, endS) of the timeline with `settings`, keeping the user's own render settings and page. */
  async function renderRange(
    tl: R,
    p: R,
    startS: number,
    endS: number,
    file: string,
    settings: Record<string, unknown>,
    format?: [string, RegExp],
  ): Promise<boolean> {
    const stopsBefore = stops;
    for (let waited = 0; await p.IsRenderingInProgress(); waited += POLL_MS) {
      if (stops !== stopsBefore) throw new Error(EXPORTS_STOPPED);
      if (waited >= BUSY_WAIT_MS) throw new Error(RENDER_BUSY);
      await sleep(POLL_MS);
    }
    const rate = await rateOf(tl);
    const start = (await tl.GetStartFrame()) as number;
    // Resolve Studio 21.1.1 refuses StartRendering on the Edit page after a still export or a settings change,
    // and for a few seconds after the Deliver page opens (12 Oct 2026). So the renders happen on the Deliver
    // page, opened once for all of a job's exports; showTracks brings the editor's page back at the end.
    const page = await resolve.GetCurrentPage();
    if (page !== "deliver") {
      pageBefore ??= page;
      await resolve.OpenPage("deliver");
      await sleep(PAGE_SETTLE_MS);
    }
    await p.DeleteRenderPreset(TEMP_PRESET);
    const saved = await p.SaveAsNewRenderPreset(TEMP_PRESET);
    // no copy of the editor's settings: the export goes on, and the panel says they changed
    if (!saved) settingsLost = true;
    let job: string | null = null;
    try {
      if (format) {
        // codec ids differ between Resolve versions and machines: take the one Resolve lists for the name
        const codecs = ((await p.GetRenderCodecs(format[0])) ?? {}) as Record<string, string>;
        const id =
          Object.entries(codecs).find(([name]) => format[1].test(name))?.[1] ??
          Object.values(codecs).find((v) => format[1].test(v));
        if (!id || !(await p.SetCurrentRenderFormatAndCodec(format[0], id))) return false;
      }
      // still refused: a few tries with a growing pause, each refused job deleted, never an endless wait.
      // Resolve 21.1.1 refuses the first start after switching between audio-only and picture renders, and
      // once refused, every later start until the settings are set again (12 Oct 2026): so they are, each try.
      for (let attempt = 1; attempt <= START_TRIES; attempt++) {
        const ok = await p.SetRenderSettings({
          SelectAllFrames: false,
          MarkIn: start + Math.round(startS * rate.fps),
          MarkOut: start + Math.round(endS * rate.fps) - 1,
          TargetDir: dirOf(file),
          CustomName: baseOf(file),
          ...settings,
        });
        if (!ok) return false;
        job = (await p.AddRenderJob()) as string;
        if (!job) return false;
        if (await p.StartRendering([job], false)) {
          for (let idle = 0; ;) {
            const status = (await p.GetRenderJobStatus(job)) as {
              JobStatus?: string;
              CompletionPercentage?: number;
            };
            if (status?.JobStatus === "Complete") return true;
            if (status?.JobStatus === "Failed" || status?.JobStatus === "Cancelled") return false;
            // a job that never leaves Ready did not start after all
            idle = status?.JobStatus === "Ready" ? idle + POLL_MS / 4 : 0;
            if (idle > READY_LIMIT_MS) break;
            await sleep(POLL_MS / 4);
          }
        }
        await p.DeleteRenderJob(job);
        job = null;
        await sleep(POLL_MS * attempt);
      }
      throw new Error(RENDER_FAILED);
    } finally {
      if (job) await p.DeleteRenderJob(job);
      if (saved) {
        if (!(await p.LoadRenderPreset(TEMP_PRESET))) settingsLost = true;
        await p.DeleteRenderPreset(TEMP_PRESET);
      }
    }
  }

  /** A new timeline's settings: the template's frame rate and size, or `size` instead. */
  function settingsLike(
    template: Record<string, string>,
    size?: { width: number; height: number },
  ) {
    return {
      useCustomSettings: "1",
      timelineResolutionWidth: size ? String(size.width) : template.timelineResolutionWidth,
      timelineResolutionHeight: size ? String(size.height) : template.timelineResolutionHeight,
      timelineFrameRate: template.timelineFrameRate,
      ...(template.timelineDropFrameTimecode
        ? { timelineDropFrameTimecode: template.timelineDropFrameTimecode }
        : {}),
    };
  }

  /**
   * Gives a new timeline the audio tracks of `kinds` ("mono", "stereo"...), in order. Its own first track is
   * kept when it is of the right kind; otherwise it goes once the source's tracks are added after it.
   */
  async function matchAudioTracks(tl: R, kinds: string[]) {
    const have = (await tl.GetTrackCount("audio")) as number;
    let same = 0;
    while (
      same < have &&
      same < kinds.length &&
      (await tl.GetTrackSubType("audio", same + 1)) === kinds[same]
    )
      same++;
    if (same === Math.min(have, kinds.length)) {
      for (const kind of kinds.slice(have)) await tl.AddTrack("audio", kind);
      return;
    }
    for (const kind of kinds.slice(same)) await tl.AddTrack("audio", kind);
    for (let n = have; n > same; n--)
      if (!(await tl.DeleteTrack("audio", n))) throw new Error(PLACE_FAILED);
  }

  /** A media pool item's own frame rate ("29.97", "50"); the timeline's when it says none. */
  async function clipRate(media: R, fallback: number): Promise<number> {
    const fps = Number(parseRate(String((await media.GetClipProperty("FPS")) ?? "")).fps);
    return Number.isFinite(fps) && fps > 0 ? fps : fallback;
  }

  /** How far the running cut got, for cutProgress; null when none runs. */
  let cutting: { done: number; total: number } | null = null;

  async function kilnframeFolder(pool: R): Promise<R> {
    const root = await pool.GetRootFolder();
    for (const f of (await root.GetSubFolderList()) ?? [])
      if ((await f.GetName()) === "Kilnframe") return f;
    return pool.AddSubFolder(root, "Kilnframe");
  }

  async function importFiles(p: R, paths: string[]): Promise<R[]> {
    const pool = await p.GetMediaPool();
    await pool.SetCurrentFolder(await kilnframeFolder(pool));
    const items = (await pool.ImportMedia(paths)) as R[];
    if (!items || items.length !== paths.length) throw new Error(PLACE_FAILED);
    return items;
  }

  /**
   * A clip rendered at 4K for a larger timeline (frame.ts insertScale) fills it with its own Scaling set to
   * Fit, whatever the project's mismatched resolution setting is: TimelineItem.SetProperty("Scaling", 2),
   * SCALE_FIT among SCALE_USE_PROJECT 0, CROP 1, FIT 2, FILL 3, STRETCH 4 (resolvedevdoc API_timeline_items).
   * False when Resolve refused it: the caller says how to do it by hand.
   */
  async function fitToTimeline(tl: R, item: R): Promise<boolean> {
    const s = (await tl.GetSetting()) as Record<string, string>;
    const scale = insertScale(
      Number(s.timelineResolutionWidth),
      Number(s.timelineResolutionHeight),
    );
    if (scale <= 1) return true;
    try {
      return Boolean(await item.SetProperty("Scaling", 2));
    } catch {
      return false;
    }
  }

  /** The percent a 4K clip needs on this timeline, said when it could not be fitted (PlaceResult.scaleByHand). */
  async function scalePercent(tl: R): Promise<number> {
    const s = (await tl.GetSetting()) as Record<string, string>;
    return Math.round(
      insertScale(Number(s.timelineResolutionWidth), Number(s.timelineResolutionHeight)) * 100,
    );
  }

  /** Appends and checks each clip landed where asked; removes them all and throws otherwise. */
  async function append(
    tl: R,
    p: R,
    infos: {
      mediaPoolItem: R;
      startFrame?: number;
      endFrame?: number;
      mediaType: 1 | 2;
      trackIndex: number;
      recordFrame: number;
    }[],
  ): Promise<R[]> {
    const pool = await p.GetMediaPool();
    const placed = ((await pool.AppendToTimeline(infos)) ?? []) as R[];
    let good = placed.length === infos.length;
    // each track read once per call: a cut appends hundreds of clips onto the same few tracks
    const spans = new Map<string, Set<string>>();
    const spansOn = async (type: "video" | "audio", index: number) => {
      const key = `${type}${index}`;
      let found = spans.get(key);
      if (!found) {
        found = new Set<string>();
        for (const x of ((await tl.GetItemListInTrack(type, index)) ?? []) as R[])
          found.add(`${await x.GetStart()}:${await x.GetEnd()}`);
        spans.set(key, found);
      }
      return found;
    };
    for (const [i, item] of placed.entries()) {
      const want = infos[i];
      if (!want) continue;
      const type = want.mediaType === 2 ? "audio" : "video";
      const from = (await item.GetStart()) as number;
      const onTrack = (await spansOn(type, want.trackIndex)).has(`${from}:${await item.GetEnd()}`);
      if (from !== want.recordFrame || !onTrack) good = false;
    }
    if (!good) {
      if (placed.length) await tl.DeleteClips(placed, false);
      throw new Error(PLACE_FAILED);
    }
    return placed;
  }

  /**
   * The file behind a timeline item, or null for a title, a generator, a compound or an offline clip. Some of
   * these hand back a media pool item that is no object with GetClipProperty, so its presence is checked.
   */
  async function pathOf(item: R): Promise<string | null> {
    const media = (await item.GetMediaPoolItem()) as R | null | undefined;
    if (!media || typeof media.GetClipProperty !== "function") return null;
    const path = await media.GetClipProperty("File Path");
    return typeof path === "string" && path ? path : null;
  }

  /**
   * The clips of `mediaPath` on a video track (1-based) starting at `atS` and lasting `durationS`, each within a
   * frame, with the item's own start and end frames.
   */
  async function captionItems(
    tl: R,
    trackIndex: number,
    mediaPath: string,
    atS: number,
    durationS: number,
  ): Promise<R[]> {
    const rate = await rateOf(tl);
    const start = (await tl.GetStartFrame()) as number;
    const found: R[] = [];
    for (const item of ((await tl.GetItemListInTrack("video", trackIndex)) ?? []) as R[]) {
      const path = await pathOf(item);
      if (!path || !samePath(path, mediaPath)) continue;
      const from = ((await item.GetStart()) as number) - start;
      const to = ((await item.GetEnd()) as number) - start;
      if (Math.abs(from / rate.fps - atS) < 1 / rate.fps)
        if (Math.abs((to - from) / rate.fps - durationS) < 1 / rate.fps) found.push(item);
    }
    return found;
  }

  /** Runs `fn`, then gives the timeline its In/Out and playhead back: appending clears and moves them. */
  async function keepingMarks<T>(tl: R, fn: () => Promise<T>): Promise<T> {
    const mark = markOf(await tl.GetMarkInOut());
    const playhead = (await tl.GetCurrentTimecode()) as string;
    try {
      return await fn();
    } finally {
      // Resolve 21.1.1 takes an In alone; an Out alone it cannot set (it clears both), so that one is lost
      if (mark.in !== undefined && mark.out !== undefined) await tl.SetMarkInOut(mark.in, mark.out);
      else if (mark.in !== undefined) await tl.SetMarkInOut(mark.in);
      await tl.SetCurrentTimecode(playhead);
    }
  }

  return {
    async currentSequence() {
      const p = await project();
      const tl = await p.GetCurrentTimeline();
      if (!tl) throw new Error(NO_SEQUENCE);
      return describe(tl, p);
    },

    /** Whether an export since the last ask left the Deliver page's settings changed; asked once a job. */
    async renderSettingsLost() {
      const lost = settingsLost;
      settingsLost = false;
      return lost;
    },

    // the panel looks twice a second: the marks alone, not the whole description
    async quickRange() {
      const p = await project();
      const tl = await p.GetCurrentTimeline();
      if (!tl) throw new Error(NO_SEQUENCE);
      // one call at a time: whether Resolve's scripting takes calls side by side is not known
      const id = (await tl.GetUniqueId()) as string;
      const rate = await rateOf(tl);
      const start = (await tl.GetStartFrame()) as number;
      const end = (await tl.GetEndFrame()) as number;
      const marks = (await tl.GetMarkInOut()) as Record<string, { in?: number; out?: number }>;
      const mark = markOf(marks);
      const length = end - start;
      return {
        id,
        inSeconds: mark?.in !== undefined ? mark.in / rate.fps : UNSET_MARK,
        outSeconds: mark?.out !== undefined ? (mark.out + 1) / rate.fps : UNSET_MARK,
        endSeconds: length / rate.fps,
      };
    },

    exportRangeAudio(id, startS, endS, file) {
      return onTimeline(id, async (tl, p) => ({
        ok: await renderRange(tl, p, startS, endS, file, {
          ExportVideo: false,
          ExportAudio: true,
          AudioFormat: "wav",
          AudioCodec: "lpcm",
          AudioBitDepth: 24,
          AudioSampleRate: 48000,
        }),
        offsetSeconds: startS,
      }));
    },

    exportRangePicture(id, startS, endS, file) {
      return onTimeline(id, async (tl, p) => {
        const s = (await tl.GetSetting()) as Record<string, string>;
        const half = (n: string) => Math.round(Number(n) / 4) * 2;
        return renderRange(
          tl,
          p,
          startS,
          endS,
          file,
          {
            ExportVideo: true,
            ExportAudio: false,
            FormatWidth: half(s.timelineResolutionWidth ?? "1920"),
            // no VideoQuality: a string there makes Resolve refuse the whole settings (12 Oct 2026)
            FormatHeight: half(s.timelineResolutionHeight ?? "1080"),
          },
          // "H.264", not "H.265"
          ["mp4", /^H\.?264\b/i],
        );
      });
    },

    exportFrame(id, seconds, file) {
      return onTimeline(id, async (tl, p) => {
        const rate = await rateOf(tl);
        const start = (await tl.GetStartFrame()) as number;
        const before = (await tl.GetCurrentTimecode()) as string;
        try {
          await tl.SetCurrentTimecode(
            framesToTimecode(start + Math.round(seconds * rate.fps), rate),
          );
          // the first export after opening a page has come back false once (11 Oct 2026); a second works
          return (
            (await p.ExportCurrentFrameAsStill(file)) || (await p.ExportCurrentFrameAsStill(file))
          );
        } finally {
          await tl.SetCurrentTimecode(before);
        }
      });
    },

    async cancelExports() {
      stops++;
    },

    async isRendering() {
      return Boolean(await (await project()).IsRenderingInProgress());
    },

    async hideOurInserts(id, startS, endS) {
      try {
        return await hideOn(id, startS, endS);
      } catch (err) {
        // no showTracks follows a failed hide: the page it left comes back now, not at a later job's end
        await restorePage();
        throw err;
      }
    },
    speechTracks(id, startS, endS) {
      return onTimeline(id, async (tl) => {
        const rate = await rateOf(tl);
        const start = (await tl.GetStartFrame()) as number;
        const from = start + Math.round(startS * rate.fps);
        const to = start + Math.round(endS * rate.fps);
        const found: number[] = [];
        const count = (await tl.GetTrackCount("audio")) as number;
        for (let i = 1; i <= count; i++) {
          if (!(await tl.GetIsTrackEnabled("audio", i))) continue;
          for (const item of ((await tl.GetItemListInTrack("audio", i)) ?? []) as R[]) {
            if ((await item.GetEnd()) <= from || (await item.GetStart()) >= to) continue;
            const path = await pathOf(item);
            // a compound clip or one without a file is the editor's own
            if (!path || !(isOurInsert(path) || isVoiceFixTake(path))) {
              found.push(i - 1);
              break;
            }
          }
        }
        return found;
      });
    },
    async soloAudioTrack(id, track) {
      try {
        return await soloOn(
          id,
          new Set((Array.isArray(track) ? track : [track]).map((t) => t + 1)),
        );
      } catch (err) {
        // no showTracks follows a failed switch: the page it left comes back now
        await restorePage();
        throw err;
      }
    },
    showTracks(id, tracks) {
      return onTimeline(id, async (tl) => {
        const back = pageBefore;
        pageBefore = null;
        if ((await resolve.GetCurrentPage()) === "deliver")
          await resolve.OpenPage(back && back !== "deliver" ? back : "edit");
        for (const t of tracks) await tl.SetTrackEnable(t.type, t.index, true);
        if (back === "deliver") await resolve.OpenPage("deliver");
      });
    },

    placeInsert(id, files, atS, handlesS, durationS, tracks) {
      return onTimeline(id, async (tl, p) => {
        const rate = await rateOf(tl);
        const start = (await tl.GetStartFrame()) as number;
        const mark = markOf(await tl.GetMarkInOut());
        const playhead = (await tl.GetCurrentTimecode()) as string;
        /** Tracks opened for this insert, taken away again when it cannot be placed. */
        const added: { type: "video" | "audio"; index: number }[] = [];
        const addTrack = async (type: "video" | "audio") => {
          await tl.AddTrack(type, ...(type === "audio" ? ["stereo"] : []));
          const index = (await tl.GetTrackCount(type)) as number;
          added.push({ type, index });
          return index;
        };
        try {
          const [video, sfx] = await importFiles(
            p,
            files.sfx ? [files.video, files.sfx] : [files.video],
          );
          let v: number;
          let a: number;
          if (tracks) {
            v = tracks.videoTrack + 1;
            a = tracks.audioTrack + 1;
          } else {
            // a timeline with one empty video track (a story timeline Kilnframe made) takes the insert on
            // V1; an audio track of our own even without sound effects: a series keeps these tracks, and a
            // later part's effects must never land on the editor's own audio
            const empty =
              (await tl.GetTrackCount("video")) === 1 &&
              !((await tl.GetItemListInTrack("video", 1)) ?? []).length;
            v = empty ? 1 : await addTrack("video");
            a = await addTrack("audio");
          }
          const handles = Math.round(handlesS * rate.fps);
          const dur = Math.round(durationS * rate.fps);
          const recordFrame = start + Math.round(atS * rate.fps);
          const clip = (item: R, mediaType: 1 | 2, trackIndex: number) => ({
            mediaPoolItem: item,
            startFrame: handles,
            // exclusive: Resolve Studio 21.1.1 placed 870 frames for 20..890 (12 Oct 2026)
            endFrame: handles + dur,
            mediaType,
            trackIndex,
            recordFrame,
          });
          let placed: R[];
          try {
            placed = await append(
              tl,
              p,
              sfx ? [clip(video, 1, v), clip(sfx, 2, a)] : [clip(video, 1, v)],
            );
          } catch (err) {
            for (const t of added.reverse()) await tl.DeleteTrack(t.type, t.index);
            throw err;
          }
          const fitted = await fitToTimeline(tl, placed[0]);
          return {
            videoTrack: v - 1,
            audioTrack: a - 1,
            ...(fitted ? {} : { scaleByHand: await scalePercent(tl) }),
          } satisfies PlacedTracks;
        } finally {
          // Resolve 21.1.1 takes an In alone; an Out alone it cannot set (it clears both), so that one is lost
          if (mark.in !== undefined && mark.out !== undefined)
            await tl.SetMarkInOut(mark.in, mark.out);
          else if (mark.in !== undefined) await tl.SetMarkInOut(mark.in);
          await tl.SetCurrentTimecode(playhead);
        }
      });
    },

    placeAudioClips(id, clips) {
      return onTimeline(id, async (tl, p) => {
        const rate = await rateOf(tl);
        const start = (await tl.GetStartFrame()) as number;
        const mark = markOf(await tl.GetMarkInOut());
        const playhead = (await tl.GetCurrentTimecode()) as string;
        let track: number | null = null;
        try {
          const items = await importFiles(
            p,
            clips.map((c) => c.file),
          );
          await tl.AddTrack("audio", "stereo");
          track = (await tl.GetTrackCount("audio")) as number;
          const a = track;
          await append(
            tl,
            p,
            clips.map((c, i) => {
              // the start and the end are rounded to frames from the sequence time, not the length on its
              // own: clips that meet in seconds then meet in frames too
              const from = Math.round(c.atS * rate.fps);
              const to = Math.round((c.atS + c.durationS) * rate.fps);
              return {
                mediaPoolItem: items[i],
                startFrame: 0,
                // exclusive, as measured for AppendToTimeline
                endFrame: to - from,
                mediaType: 2 as const,
                trackIndex: a,
                recordFrame: start + from,
              };
            }),
          );
          return { audioTrack: a - 1 };
        } catch (err) {
          if (track !== null) await tl.DeleteTrack("audio", track);
          throw err;
        } finally {
          if (mark.in !== undefined && mark.out !== undefined)
            await tl.SetMarkInOut(mark.in, mark.out);
          else if (mark.in !== undefined) await tl.SetMarkInOut(mark.in);
          await tl.SetCurrentTimecode(playhead);
        }
      });
    },

    // Timeline.GetItemListInTrack(type, index), TimelineItem.GetStart/GetEnd (timeline frames, absolute) and
    // GetMediaPoolItem().GetClipProperty("File Path"): DaVinci Resolve Scripting README, Timeline and
    // TimelineItem (Help > Documentation > Developer, Scripting/README.md).
    ourInsertSpans(id) {
      return onTimeline(id, async (tl) => {
        const rate = await rateOf(tl);
        const start = (await tl.GetStartFrame()) as number;
        const spans: { startS: number; endS: number }[] = [];
        const count = (await tl.GetTrackCount("video")) as number;
        for (let i = 1; i <= count; i++)
          for (const item of ((await tl.GetItemListInTrack("video", i)) ?? []) as R[]) {
            const path = await pathOf(item);
            if (!path || !isOurAnimation(path)) continue;
            spans.push({
              startS: ((await item.GetStart()) - start) / rate.fps,
              endS: ((await item.GetEnd()) - start) / rate.fps,
            });
          }
        return spans.sort((a, b) => a.startS - b.startS);
      });
    },

    findCaptionClip(id, mediaPath, atS, durationS) {
      return onTimeline(id, async (tl) => {
        const count = (await tl.GetTrackCount("video")) as number;
        for (let i = 1; i <= count; i++)
          if ((await captionItems(tl, i, mediaPath, atS, durationS)).length)
            return { videoTrack: i - 1 };
        return null;
      });
    },

    // Timeline.DeleteClips([timelineItems], rippleDelete) takes the old clip off the timeline only (not
    // MediaPool.DeleteClips, which would take it out of the media pool too); MediaPool.AppendToTimeline with
    // {mediaPoolItem, startFrame, endFrame, mediaType: 1 (video only), trackIndex, recordFrame} places the new
    // one; Timeline.GetIsTrackLocked(type, index): a locked track takes neither. DaVinci Resolve Scripting README,
    // MediaPool and Timeline (Help > Documentation > Developer, Scripting/README.md).
    replaceCaptionClip(id, earlier, file, atS, durationS, videoTrack) {
      return onTimeline(id, (tl, p) =>
        keepingMarks(tl, async () => {
          const track = videoTrack + 1;
          if (await tl.GetIsTrackLocked("video", track)) throw new Error(PLACE_FAILED);
          const old = await captionItems(tl, track, earlier.path, earlier.atS, earlier.durationS);
          // moved, trimmed or gone since it was found: nothing goes onto that track
          if (!old.length) return false;
          const rate = await rateOf(tl);
          const start = (await tl.GetStartFrame()) as number;
          const [item] = await importFiles(p, [file]);
          // the old clip as it lay, to put back when the new one cannot be placed
          const before = await Promise.all(
            old.map(async (x) => {
              const from = (await x.GetStart()) as number;
              const to = (await x.GetEnd()) as number;
              const sourceIn = (await x.GetSourceStartFrame()) as number;
              return {
                mediaPoolItem: await x.GetMediaPoolItem(),
                startFrame: sourceIn,
                // exclusive, as measured for AppendToTimeline
                endFrame: sourceIn + (to - from),
                mediaType: 1 as const,
                trackIndex: track,
                recordFrame: from,
              };
            }),
          );
          if (!(await tl.DeleteClips(old, false))) throw new Error(PLACE_FAILED);
          const from = Math.round(atS * rate.fps);
          const to = Math.round((atS + durationS) * rate.fps);
          let placed: R[];
          try {
            placed = await append(tl, p, [
              {
                mediaPoolItem: item,
                startFrame: 0,
                endFrame: to - from,
                mediaType: 1,
                trackIndex: track,
                recordFrame: start + from,
              },
            ]);
          } catch (err) {
            await append(tl, p, before).catch(() => undefined);
            throw err;
          }
          await fitToTimeline(tl, placed[0]);
          return true;
        }),
      );
    },

    async createStorySequence(templateId, name, narration, music, format) {
      const template = await onTimeline(
        templateId,
        async (tl) => (await tl.GetSetting()) as Record<string, string>,
      );
      const p = await project();
      const [voice, bed] = await importFiles(p, music ? [narration, music] : [narration]);
      const pool = await p.GetMediaPool();
      const tl = await pool.CreateEmptyTimeline(name);
      if (!tl) throw new Error(PLACE_FAILED);
      await p.SetCurrentTimeline(tl);
      const w = Number(template.timelineResolutionWidth);
      const h = Number(template.timelineResolutionHeight);
      await tl.SetSettings(settingsLike(template, format ? frameFor(format, w, h) : undefined));
      if (bed) await tl.AddTrack("audio", "stereo");
      const start = (await tl.GetStartFrame()) as number;
      // whole clips: a WAV's "Frames" property comes back empty, so no start/end frames are given
      const infos = (
        bed
          ? [
              [voice, 1],
              [bed, 2],
            ]
          : [[voice, 1]]
      ).map(([item, trackIndex]) => ({
        mediaPoolItem: item,
        mediaType: 2 as const,
        trackIndex: trackIndex as number,
        recordFrame: start,
      }));
      await append(tl, p, infos);
    },

    // There is no razor in Resolve's scripting API: the cut rebuilds the timeline from its source clips into a
    // new one (MediaPool.CreateEmptyTimeline, AppendToTimeline with startFrame/endFrame in source frames,
    // TimelineItem.GetSourceStartFrame). Grades, effects, titles and transitions do not come along; the
    // original timeline is only read.
    async cutToNewTimeline(id, cuts, name) {
      const p = await project();
      const editorTimeline = await p.GetCurrentTimeline();
      const source = await findTimeline(p, id);
      const settings = (await source.GetSetting()) as Record<string, string>;
      const rate = await rateOf(source);
      const start = (await source.GetStartFrame()) as number;
      const frames = frameCuts(cuts, rate.fps, ((await source.GetEndFrame()) as number) - start);
      const sourceMark = markOf(await source.GetMarkInOut());

      // everything is read before anything is made
      const audioKinds: string[] = [];
      let videoTracks = 0;
      const off: HiddenTrack[] = [];
      const pieces: {
        media: R;
        startFrame: number;
        endFrame: number;
        mediaType: 1 | 2;
        trackIndex: number;
        at: number;
      }[] = [];
      let leftOut = 0;
      for (const type of ["video", "audio"] as const) {
        const count = (await source.GetTrackCount(type)) as number;
        if (type === "video") videoTracks = count;
        for (let i = 1; i <= count; i++) {
          if (type === "audio")
            audioKinds.push((await source.GetTrackSubType("audio", i)) as string);
          if (!(await source.GetIsTrackEnabled(type, i))) off.push({ type, index: i });
          for (const item of ((await source.GetItemListInTrack(type, i)) ?? []) as R[]) {
            const from = ((await item.GetStart()) as number) - start;
            const to = ((await item.GetEnd()) as number) - start;
            const kept = piecesOf(
              { key: "", track: i, kind: type, startF: from, endF: to },
              frames,
            );
            // wholly inside the cuts: meant to go
            if (!kept.length) continue;
            // a title, generator or Fusion clip has no real media pool item
            const media = (await item.GetMediaPoolItem()) as R | null | undefined;
            if (!media || typeof media.GetClipProperty !== "function") {
              leftOut++;
              continue;
            }
            // source frames count at the clip's own rate (50 fps B-roll on a 25 fps timeline runs two per
            // timeline frame); only a real speed change is left out. Within one frame: whether the source end
            // frame is inclusive is not documented
            const sourceIn = (await item.GetSourceStartFrame()) as number;
            const sourceLength = ((await item.GetSourceEndFrame()) as number) - sourceIn;
            const ratio = playRatio(
              (await clipRate(media, rate.fps)) / rate.fps,
              sourceLength,
              to - from,
            );
            if (ratio === null) {
              leftOut++;
              continue;
            }
            const sourceAt = (f: number) => sourceIn + Math.round((f - from) * ratio);
            for (const piece of kept)
              pieces.push({
                media,
                startFrame: sourceAt(piece.fromF),
                // exclusive, as measured for AppendToTimeline
                endFrame: sourceAt(piece.toF),
                mediaType: type === "audio" ? 2 : 1,
                trackIndex: i,
                at: piece.newStartF,
              });
          }
        }
      }

      const pool = await p.GetMediaPool();
      const tl = await pool.CreateEmptyTimeline(name);
      if (!tl) throw new Error(`${CUT_FAILED}: CreateEmptyTimeline gave no timeline`);
      cutting = { done: 0, total: pieces.length };
      try {
        // appends act on the current timeline
        await p.SetCurrentTimeline(tl);
        await tl.SetSettings(settingsLike(settings));
        for (let n = (await tl.GetTrackCount("video")) as number; n < videoTracks; n++)
          await tl.AddTrack("video");
        await matchAudioTracks(tl, audioKinds);
        const at = (await tl.GetStartFrame()) as number;
        for (let i = 0; i < pieces.length; i += CUT_BATCH) {
          const batch = pieces.slice(i, i + CUT_BATCH);
          await append(
            tl,
            p,
            batch.map((c) => ({
              mediaPoolItem: c.media,
              startFrame: c.startFrame,
              endFrame: c.endFrame,
              mediaType: c.mediaType,
              trackIndex: c.trackIndex,
              recordFrame: at + c.at,
            })),
          );
          cutting.done += batch.length;
        }
        // switched off after the appends, as on the original: whether Resolve appends onto a disabled track
        // is not measured
        for (const t of off) await tl.SetTrackEnable(t.type, t.index, false);
        // the editor's In and Out follow their content (a mark inside a pause goes to its edge); relative to
        // the timeline start, Out the last frame. Resolve takes an In alone but no Out alone
        if (sourceMark.in !== undefined) {
          const markIn = newEndF(sourceMark.in, frames);
          const markOut =
            sourceMark.out !== undefined
              ? Math.max(markIn, newEndF(sourceMark.out + 1, frames) - 1)
              : undefined;
          await (
            markOut !== undefined ? tl.SetMarkInOut(markIn, markOut) : tl.SetMarkInOut(markIn)
          ).catch(() => false);
        }
        return {
          id: (await tl.GetUniqueId()) as string,
          name: (await tl.GetName()) as string,
          leftOut,
          rebuilt: true,
          inPlace: false,
        };
      } catch (err) {
        await pool.DeleteTimelines([tl]).catch(() => false);
        if (editorTimeline) await p.SetCurrentTimeline(editorTimeline).catch(() => false);
        // the reason in the message: a cause does not cross from the app to the panel window
        const why = err instanceof Error ? err.message : String(err);
        throw new Error(`${CUT_FAILED}: ${why}`, { cause: err });
      } finally {
        cutting = null;
      }
    },

    async cutProgress() {
      return cutting && { ...cutting };
    },
  };
}

/**
 * Source frames per timeline frame for a clip, or null when it is retimed (a real speed change). `rateRatio`
 * is the clip's rate over the timeline's; Resolve may instead conform 29.97 footage on a 30 timeline (23.976
 * on 24) frame for frame, so a long clip 0.1 % off the rate-converted length is not retimed. Within one
 * frame either way: whether the source end frame is inclusive is not documented.
 */
export function playRatio(rateRatio: number, sourceLength: number, length: number): number | null {
  if (Math.abs(sourceLength / rateRatio - length) <= 1) return rateRatio;
  if (Math.abs(sourceLength - length) <= 1) return 1;
  if (length > 0) {
    // rounding on a long clip: the observed ratio within 0.2 % of either reading
    const seen = sourceLength / length;
    if (Math.abs(seen / rateRatio - 1) < 0.002) return rateRatio;
    if (Math.abs(seen - 1) < 0.002) return 1;
  }
  return null;
}
