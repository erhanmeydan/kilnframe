// An in-memory DaVinci Resolve with the promise API the bridge uses, including the quirks seen in Resolve
// Studio 21.1.1: AppendToTimeline clears In/Out and moves the playhead, slides a clip off an occupied spot,
// and "places" nothing on a locked track while still returning the item.

export interface FakeItem {
  start: number;
  end: number;
  sourceIn: number;
  sourceOut: number;
  path: string;
}
export interface FakeTrack {
  items: FakeItem[];
  enabled: boolean;
  locked: boolean;
}
export interface FakeTimeline {
  id: string;
  name: string;
  start: number;
  length: number;
  settings: Record<string, string>;
  mark: { in?: number; out?: number };
  playhead: string;
  tracks: { video: FakeTrack[]; audio: FakeTrack[] };
}

export interface FakeOptions {
  markIn?: number;
  markOut?: number;
  playhead?: string;
  noTimeline?: boolean;
  noProject?: boolean;
  renderingFor?: number;
  lockTopVideoTrackOnAdd?: boolean;
  ourInsertOnV2?: boolean;
  failFirstStill?: boolean;
  /** StartRendering returns false this many times before it works (Infinity: never). */
  refuseStarts?: number;
}

const track = (items: FakeItem[] = []): FakeTrack => ({ items, enabled: true, locked: false });
const tc = (frames: number) => {
  const f = frames % 25;
  const s = Math.floor(frames / 25);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(f)}`;
};

export function makeFakeResolve(o: FakeOptions = {}) {
  const log = {
    renderSettings: [] as Record<string, unknown>[],
    startRendering: [] as string[][],
    deletedJobs: [] as string[],
    presets: [] as string[],
    pages: [] as string[],
    timecodes: [] as string[],
    stills: [] as string[],
    formats: [] as string[],
  };
  const newTimeline = (id: string, name: string): FakeTimeline => ({
    id,
    name,
    start: 90000,
    length: 271,
    settings: {
      timelineResolutionWidth: "1920",
      timelineResolutionHeight: "1080",
      timelineFrameRate: "25",
      timelineDropFrameTimecode: "0",
    },
    mark: {},
    playhead: "01:00:00:00",
    tracks: { video: [track()], audio: [track()] },
  });
  const main = newTimeline("tl-1", "Probe");
  main.tracks.video[0]!.items.push({
    start: 90000,
    end: 90271,
    sourceIn: 0,
    sourceOut: 270,
    path: "/footage.mp4",
  });
  main.tracks.audio[0]!.items.push({
    start: 90000,
    end: 90271,
    sourceIn: 0,
    sourceOut: 270,
    path: "/footage.mp4",
  });
  if (o.markIn !== undefined) main.mark.in = o.markIn;
  if (o.markOut !== undefined) main.mark.out = o.markOut;
  if (o.playhead) main.playhead = o.playhead;
  if (o.ourInsertOnV2)
    main.tracks.video.push(
      track([
        {
          start: 90000,
          end: 90200,
          sourceIn: 0,
          sourceOut: 199,
          path: "/m/Kilnframe/old/insert.mov",
        },
      ]),
    );

  const timelines: FakeTimeline[] = o.noTimeline ? [] : [main];
  const project = {
    name: "Kilnframe Probe",
    current: (o.noTimeline ? null : main) as FakeTimeline | null,
    timeline: main,
    timelines,
  };
  let page = "edit";
  let renderingPolls = o.renderingFor ?? 0;
  let jobs = 0;
  let stillCalls = 0;
  let refusals = o.refuseStarts ?? 0;
  const started = new Set<string>();
  const folders: { name: string; subs: unknown[] }[] = [];
  const root = { name: "Master", subs: folders };

  const mpi = (path: string) => ({
    path,
    GetClipProperty: async (k?: string) => (k === "File Path" ? path : { "File Path": path }),
  });
  const wrapItem = (tl: FakeTimeline, type: "video" | "audio", idx: number, it: FakeItem) => ({
    raw: it,
    GetStart: async () => it.start,
    GetEnd: async () => it.end,
    GetTrackTypeAndIndex: async () => [type, idx],
    GetMediaPoolItem: async () => mpi(it.path),
    tl,
  });
  const folderApi = (f: { name: string; subs: unknown[] }) => ({
    raw: f,
    GetName: async () => f.name,
    GetSubFolderList: async () => (f.subs as { name: string; subs: unknown[] }[]).map(folderApi),
  });

  function timelineApi(tl: FakeTimeline) {
    const list = (type: "video" | "audio") => tl.tracks[type];
    return {
      raw: tl,
      GetUniqueId: async () => tl.id,
      GetName: async () => tl.name,
      GetSetting: async (k?: string) => (k ? tl.settings[k] : { ...tl.settings }),
      SetSettings: async (s: Record<string, string>) => {
        Object.assign(tl.settings, s);
        return true;
      },
      GetStartFrame: async () => tl.start,
      GetEndFrame: async () => tl.start + tl.length,
      GetMarkInOut: async () => {
        const r: Record<string, { in?: number; out?: number }> = {};
        if (tl.mark.in !== undefined || tl.mark.out !== undefined) {
          r.video = { ...tl.mark };
          r.audio = { ...tl.mark };
        } else {
          r.video = {};
          r.audio = {};
        }
        return r;
      },
      SetMarkInOut: async (i: number, out: number) => {
        tl.mark = { in: i, out };
        return true;
      },
      GetCurrentTimecode: async () => tl.playhead,
      SetCurrentTimecode: async (t: string) => {
        log.timecodes.push(t);
        tl.playhead = t;
        return true;
      },
      GetTrackCount: async (type: "video" | "audio") => list(type).length,
      AddTrack: async (type: "video" | "audio") => {
        const t = track();
        if (type === "video" && o.lockTopVideoTrackOnAdd) t.locked = true;
        list(type).push(t);
        return true;
      },
      GetItemListInTrack: async (type: "video" | "audio", i: number) =>
        (list(type)[i - 1]?.items ?? []).map((it) => wrapItem(tl, type, i, it)),
      SetTrackEnable: async (type: "video" | "audio", i: number, on: boolean) => {
        const t = list(type)[i - 1];
        if (!t) return false;
        t.enabled = on;
        return true;
      },
      GetIsTrackEnabled: async (type: "video" | "audio", i: number) =>
        list(type)[i - 1]?.enabled ?? false,
      GetIsTrackLocked: async (type: "video" | "audio", i: number) =>
        list(type)[i - 1]?.locked ?? false,
      DeleteClips: async (items: { raw: FakeItem }[]) => {
        for (const t of [...tl.tracks.video, ...tl.tracks.audio])
          t.items = t.items.filter((it) => !items.some((x) => x.raw === it));
        return true;
      },
    };
  }

  const mediaPool = {
    GetRootFolder: async () => folderApi(root),
    AddSubFolder: async (parent: { raw: { subs: unknown[] } }, name: string) => {
      const f = { name, subs: [] };
      parent.raw.subs.push(f);
      return folderApi(f);
    },
    SetCurrentFolder: async () => true,
    ImportMedia: async (paths: string[]) => paths.map(mpi),
    CreateEmptyTimeline: async (name: string) => {
      const tl = newTimeline(`tl-${timelines.length + 1}`, name);
      timelines.push(tl);
      return timelineApi(tl);
    },
    AppendToTimeline: async (
      infos: {
        mediaPoolItem: { path: string };
        startFrame?: number;
        endFrame?: number;
        mediaType: number;
        trackIndex: number;
        recordFrame: number;
      }[],
    ) => {
      const tl = project.current as FakeTimeline;
      const out = [];
      for (const info of infos) {
        const type = info.mediaType === 2 ? "audio" : "video";
        const t = tl.tracks[type][info.trackIndex - 1] as FakeTrack;
        // a whole clip when no frames are given (a WAV of the fake is 250 frames long)
        const len = info.endFrame !== undefined ? info.endFrame - (info.startFrame ?? 0) + 1 : 250;
        let start = info.recordFrame;
        for (const it of t.items) if (start < it.end && start + len > it.start) start = it.end;
        const it: FakeItem = {
          start,
          end: start + len,
          sourceIn: info.startFrame ?? 0,
          sourceOut: info.endFrame ?? len - 1,
          path: info.mediaPoolItem.path,
        };
        if (!t.locked) t.items.push(it);
        out.push(wrapItem(tl, type, info.trackIndex, it));
        tl.mark = {};
        tl.playhead = tc(start + len);
      }
      return out;
    },
  };

  const projectApi = {
    GetName: async () => project.name,
    GetCurrentTimeline: async () => (project.current ? timelineApi(project.current) : null),
    GetTimelineCount: async () => timelines.length,
    GetTimelineByIndex: async (i: number) =>
      timelines[i - 1] ? timelineApi(timelines[i - 1] as FakeTimeline) : null,
    SetCurrentTimeline: async (t: { raw: FakeTimeline }) => {
      project.current = t.raw;
      return true;
    },
    GetMediaPool: async () => mediaPool,
    SaveAsNewRenderPreset: async (n: string) => (log.presets.push(`save:${n}`), true),
    LoadRenderPreset: async (n: string) => (log.presets.push(`load:${n}`), true),
    DeleteRenderPreset: async (n: string) => (log.presets.push(`delete:${n}`), true),
    GetRenderPresetList: async () => [] as string[],
    SetRenderSettings: async (s: Record<string, unknown>) => (log.renderSettings.push(s), true),
    SetCurrentRenderFormatAndCodec: async (f: string, c: string) => (
      log.formats.push(`${f}/${c}`),
      true
    ),
    GetRenderCodecs: async (ext: string) =>
      ext === "mp4" ? { "H.265 Main10": "H265_Main10", "H.264": "H264_Main" } : {},
    AddRenderJob: async () => `job-${++jobs}`,
    StartRendering: async (ids: string[]) => {
      log.startRendering.push(ids);
      if (refusals > 0) {
        refusals--;
        return false;
      }
      started.add(ids[0] as string);
      return true;
    },
    IsRenderingInProgress: async () => {
      if (renderingPolls > 0) {
        renderingPolls--;
        return true;
      }
      return false;
    },
    GetRenderJobStatus: async (id: string) =>
      started.has(id)
        ? { JobStatus: "Complete", CompletionPercentage: 100 }
        : { JobStatus: "Ready", CompletionPercentage: 0 },
    DeleteRenderJob: async (id: string) => (log.deletedJobs.push(id), true),
    ExportCurrentFrameAsStill: async (p: string) => {
      stillCalls++;
      if (o.failFirstStill && stillCalls === 1) return false;
      log.stills.push(p);
      return true;
    },
  };

  const resolve = {
    GetProjectManager: async () => ({
      GetCurrentProject: async () => (o.noProject ? null : projectApi),
    }),
    GetCurrentPage: async () => page,
    OpenPage: async (p: string) => {
      page = p;
      log.pages.push(p);
      return true;
    },
    GetProductName: async () => "DaVinci Resolve Studio",
  };
  return {
    resolve,
    log,
    project: project as unknown as {
      current: FakeTimeline;
      timeline: FakeTimeline;
      timelines: FakeTimeline[];
    },
  };
}
