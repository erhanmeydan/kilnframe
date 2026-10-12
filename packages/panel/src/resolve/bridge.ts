// Everything the panel asks of DaVinci Resolve Studio, through the Workflow Integration promise API (Resolve 20.1+).
// Runs in the panel's Electron main process; `resolve` is WorkflowIntegration.GetResolvePromise(), or a fake in
// tests. Behaviour measured on Resolve Studio 21.1.1:
// - Timeline.GetMarkInOut() is relative to the timeline start; renders and placement want absolute frames.
// - MediaPool.AppendToTimeline clears In/Out, moves the playhead, slides a clip off an occupied spot and places
//   nothing on a locked track while still returning the item: everything is read back and checked.
// - Rendering changes the Deliver page's settings and Resolve cannot report them: they are kept as a preset.
// - Renders, frame exports and appends act on the current timeline: the target is made current for them.
import {
  NO_SEQUENCE,
  PLACE_FAILED,
  RENDER_BUSY,
  RENDER_FAILED,
  type HiddenTrack,
  type PlacedTracks,
  type ResolveBridge,
  type ResolveSequence,
} from "./api";
import { frameFor } from "../frame";
import { isOurInsert } from "../our-files";
import { framesToTimecode, parseRate, rateString, type Rate } from "./timecode";

/* eslint-disable @typescript-eslint/no-explicit-any -- Resolve's promise objects are untyped */
type R = any;

const TEMP_PRESET = "Kilnframe Temp";
const BUSY_WAIT_MS = 10 * 60_000;
const POLL_MS = 2_000;
const START_TRIES = 5;
const PAGE_SETTLE_MS = 500;
const READY_LIMIT_MS = 15_000;

const dirOf = (p: string) => p.replace(/[\\/][^\\/]*$/, "");
const baseOf = (p: string) => p.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");

export function createResolveBridge(
  resolve: R,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): ResolveBridge {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));

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

  /** The timeline with this id, made current for `fn`, the previous current one restored afterwards. */
  async function onTimeline<T>(id: string, fn: (tl: R, p: R) => Promise<T>): Promise<T> {
    const p = await project();
    const current = await p.GetCurrentTimeline();
    if (current && (await current.GetUniqueId()) === id) return fn(current, p);
    const count = await p.GetTimelineCount();
    for (let i = 1; i <= count; i++) {
      const tl = await p.GetTimelineByIndex(i);
      if (tl && (await tl.GetUniqueId()) === id) {
        await p.SetCurrentTimeline(tl);
        try {
          return await fn(tl, p);
        } finally {
          if (current) await p.SetCurrentTimeline(current);
        }
      }
    }
    throw new Error(NO_SEQUENCE);
  }

  async function describe(tl: R, p: R): Promise<ResolveSequence> {
    const s = (await tl.GetSetting()) as Record<string, string>;
    const rate = await rateOf(tl);
    const start = (await tl.GetStartFrame()) as number;
    const end = (await tl.GetEndFrame()) as number;
    const marks = (await tl.GetMarkInOut()) as Record<string, { in?: number; out?: number }>;
    const mark =
      marks.video?.in !== undefined || marks.video?.out !== undefined ? marks.video : marks.audio;
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
      inSeconds: (mark?.in ?? 0) / rate.fps,
      // Out is the last frame of the range, inclusive
      outSeconds: mark?.out !== undefined ? (mark.out + 1) / rate.fps : length / rate.fps,
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
    for (let waited = 0; await p.IsRenderingInProgress(); waited += POLL_MS) {
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
        await p.LoadRenderPreset(TEMP_PRESET);
        await p.DeleteRenderPreset(TEMP_PRESET);
      }
    }
  }

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
  ): Promise<void> {
    const pool = await p.GetMediaPool();
    const placed = ((await pool.AppendToTimeline(infos)) ?? []) as R[];
    let good = placed.length === infos.length;
    for (const [i, item] of placed.entries()) {
      const want = infos[i];
      if (!want) continue;
      const type = want.mediaType === 2 ? "audio" : "video";
      const there = ((await tl.GetItemListInTrack(type, want.trackIndex)) ?? []) as R[];
      const onTrack = await Promise.all(
        there.map(
          async (x) =>
            (await x.GetStart()) === (await item.GetStart()) &&
            (await x.GetEnd()) === (await item.GetEnd()),
        ),
      );
      if ((await item.GetStart()) !== want.recordFrame || !onTrack.some(Boolean)) good = false;
    }
    if (!good) {
      if (placed.length) await tl.DeleteClips(placed, false);
      throw new Error(PLACE_FAILED);
    }
  }

  return {
    async currentSequence() {
      const p = await project();
      const tl = await p.GetCurrentTimeline();
      if (!tl) throw new Error(NO_SEQUENCE);
      return describe(tl, p);
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

    async isRendering() {
      return Boolean(await (await project()).IsRenderingInProgress());
    },

    hideOurInserts(id, startS, endS) {
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
              const path = await (await item.GetMediaPoolItem())?.GetClipProperty("File Path");
              if (typeof path === "string" && isOurInsert(path)) ours = true;
            }
            if (ours && (await tl.SetTrackEnable(type, i, false))) hidden.push({ type, index: i });
          }
        }
        return hidden;
      });
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
        const marks = (await tl.GetMarkInOut()) as Record<string, { in?: number; out?: number }>;
        const mark = marks.video ?? marks.audio ?? {};
        const playhead = (await tl.GetCurrentTimecode()) as string;
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
            // an audio track of our own even without sound effects: a series keeps these tracks, and a
            // later part's effects must never land on the editor's own audio
            await tl.AddTrack("video");
            await tl.AddTrack("audio", "stereo");
            v = (await tl.GetTrackCount("video")) as number;
            a = (await tl.GetTrackCount("audio")) as number;
          }
          const handles = Math.round(handlesS * rate.fps);
          const dur = Math.round(durationS * rate.fps);
          const recordFrame = start + Math.round(atS * rate.fps);
          const clip = (item: R, mediaType: 1 | 2, trackIndex: number) => ({
            mediaPoolItem: item,
            startFrame: handles,
            endFrame: handles + dur - 1,
            mediaType,
            trackIndex,
            recordFrame,
          });
          await append(tl, p, sfx ? [clip(video, 1, v), clip(sfx, 2, a)] : [clip(video, 1, v)]);
          return { videoTrack: v - 1, audioTrack: a - 1 } satisfies PlacedTracks;
        } finally {
          if (mark.in !== undefined && mark.out !== undefined)
            await tl.SetMarkInOut(mark.in, mark.out);
          await tl.SetCurrentTimecode(playhead);
        }
      });
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
      const size = format ? frameFor(format, w, h) : { width: w, height: h };
      await tl.SetSettings({
        useCustomSettings: "1",
        timelineResolutionWidth: String(size.width),
        timelineResolutionHeight: String(size.height),
        timelineFrameRate: template.timelineFrameRate,
        ...(template.timelineDropFrameTimecode
          ? { timelineDropFrameTimecode: template.timelineDropFrameTimecode }
          : {}),
      });
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
  };
}
