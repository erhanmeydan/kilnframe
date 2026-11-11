// The Premiere Pro host: the UXP API (@adobe/premierepro 26.5) behind the panel's Host interface. Every call
// here is written from the official type definitions; the probe panel confirms the behaviour inside Premiere.
import type {
  Action,
  AudioClipTrackItem,
  CompoundAction,
  FolderItem,
  Project,
  ProjectItem,
  Sequence,
  TrackItemSelection,
  VideoClipTrackItem,
  premierepro,
} from "@adobe/premierepro";
import {
  frameCuts,
  newEndF,
  piecesOf,
  seedLength,
  shiftAt,
  type FrameCut,
  type PlanItem,
} from "./cut-plan";
import { frameFor, insertScale } from "./frame";
import { formatRational, rationalFps } from "./fps";
import { withoutLongPathPrefix } from "./home";
import type { CutSequenceResult, Host, HostSequence, PlaceResult, TimelineCut } from "./host";
import { exportError } from "./export-cancel";
import { premiereCall } from "./premiere-version";
import { t } from "./i18n";
import { isOurAnimation, isOurInsert, isVoiceFixTake } from "./our-files";

export interface UxpModule {
  host?: { uiLocale?: string };
  versions?: { plugin?: unknown };
  shell: { openExternal(url: string): Promise<unknown> };
  storage: {
    localFileSystem: {
      getFileForOpening(o: {
        allowMultiple: boolean;
        types: string[];
      }): Promise<{ nativePath: string }[] | { nativePath: string } | null>;
      getFileForSaving(
        suggestedName: string,
        o: { types: string[] },
      ): Promise<{ nativePath: string; write(data: string): Promise<unknown> } | null>;
    };
  };
}
export interface FsModule {
  readFile(path: string, options: { encoding: string }): Promise<string>;
  writeFile(path: string, data: string, options: { encoding: string }): Promise<void>;
  lstat(path: string): Promise<unknown>;
}
export interface OsModule {
  homedir(): string | null;
  platform?: () => string;
}

interface SequenceInfo {
  name: string;
  inSeconds: number;
  outSeconds: number;
  fps: string;
  fpsValue: number;
  width: number;
  height: number;
  videoTracks: number;
  audioTracks: number;
}

/** A clip on a track, as far as the panel reads it. */
interface Clip {
  getStartTime(): Promise<{ seconds: number }>;
  getEndTime(): Promise<{ seconds: number }>;
  getProjectItem(): Promise<ProjectItem>;
}

/** A clip's effects, as far as scaling it reads them (VideoClipTrackItem.getComponentChain). */
interface Effects {
  getComponentCount(): number;
  getComponentAtIndex(i: number): {
    getMatchName(): Promise<string>;
    getParam(i: number): {
      displayName?: string;
      createKeyframe(value: number): unknown;
      createSetValueAction(keyframe: unknown, safeForPlayback: boolean): unknown;
    };
  };
}

/** A track that can be switched off for an export (video and audio tracks both can). */
interface Mutable {
  isMuted(): Promise<boolean>;
  setMute(mute: boolean): Promise<boolean>;
  getTrackItems(type: number, includeEmpty: boolean): Clip[];
}

const isWin = (os: OsModule) =>
  os.platform ? os.platform() === "win32" : /^[a-z]:/i.test(os.homedir() ?? "");

/**
 * A path as the operating system writes it, for Premiere's own calls. The panel keeps paths with "/", which
 * Premiere on Windows turns into \\?\C:\...\Kilnframe/job/sequence.wav, and Windows refuses a "/" after that
 * prefix ("Unable To Delete Existing File", 11 Oct 2026).
 */
const nativePathFor = (os: OsModule, path: string) =>
  isWin(os) ? path.replace(/\//g, "\\") : path;

/** True when two paths name the same file, whichever slashes and letter case Windows gave them. */
const samePathFor = (os: OsModule, a: string, b: string) => {
  if (!isWin(os)) return a === b;
  const norm = (p: string) => p.replace(/\//g, "\\").toLowerCase();
  return norm(a) === norm(b);
};

/** A clip of the sequence being cut, as the cut plan needs it. */
export interface CutClipInfo {
  plan: PlanItem;
  /** Its in point in its media, in ticks; null when it could not be read. */
  inTicks: number | null;
  speed: number;
  reversed: boolean;
}

/** Where a clip is found after the copies are made: its kind, track and start frame name it. */
interface ClipAt {
  kind: PlanItem["kind"];
  track: number;
  atF: number;
}

/** A clip as the finished sequence should hold it; inTicks null when it is not checked. */
export interface ExpectedClip {
  kind: PlanItem["kind"];
  track: number;
  startF: number;
  endF: number;
  inTicks: number | null;
}

/** The edits of a cut, phase by phase; each phase is one transaction on the copy of the sequence. */
export interface PremiereCutPlan {
  /** A: clips with nothing left. */
  remove: string[];
  /** B: every clip with pieces trimmed to its seed (null: that edge stays). */
  trims: { key: string; startF: number | null; endF: number | null }[];
  /** C: copies of a seed, at its start plus offsetF. */
  clones: { key: string; offsetF: number }[];
  /** D: a seed or copy, found at atF, gets its in point and grows to its piece's end. */
  fixes: (ClipAt & { inTicks: number | null; endF: number | null })[];
  /** E: a piece, found at atF, shifts by byF; per track from left to right. */
  moves: (ClipAt & { byF: number })[];
  expected: ExpectedClip[];
  /** Clips that could only keep their first piece (reversed, or an in point that could not be read). */
  leftOut: number;
}

/**
 * The cut of a copy of a sequence through Premiere's public track item actions, as measured in Premiere 26.5:
 * set start trims (the in point follows), set end shrinks and grows into free space, a cloned track item lands
 * at the item's start plus an offset on its own track with the same in point and length and overwrites what
 * lies under it, a move is a relative shift that never overwrites, and a video clip's linked audio is not
 * touched by its edits, so every clip is planned on its own. Each clip is trimmed to a seed as long as its
 * shortest piece; the seed is cloned into each further piece (inside the clip's own old span, so a clone can
 * never overwrite a neighbour), every copy gets its in point and end, and the pieces shift left in order, only
 * ever into space already emptied.
 */
export function planPremiereCut(
  clips: CutClipInfo[],
  cuts: FrameCut[],
  ticksPerFrame: number,
): PremiereCutPlan {
  const plan: PremiereCutPlan = {
    remove: [],
    trims: [],
    clones: [],
    fixes: [],
    moves: [],
    expected: [],
    leftOut: 0,
  };
  for (const c of clips) {
    const { key, kind, track, startF, endF } = c.plan;
    let pieces = piecesOf(c.plan, cuts);
    if (!pieces.length) {
      plan.remove.push(key);
      continue;
    }
    const splittable = !c.reversed && c.inTicks !== null;
    if (!splittable && pieces.length > 1) {
      // a copy's in point cannot be set right without the source's direction and start: keep the first piece
      pieces = [pieces[0]];
      plan.leftOut++;
    }
    const inAt = (f: number) =>
      splittable
        ? (c.inTicks as number) + Math.round((f - startF) * ticksPerFrame * c.speed)
        : null;
    const first = pieces[0];
    const trimStart = first.fromF > startF ? first.fromF : null;
    if (pieces.length === 1) {
      const trimEnd = first.toF < endF ? first.toF : null;
      if (trimStart !== null || trimEnd !== null)
        plan.trims.push({ key, startF: trimStart, endF: trimEnd });
    } else {
      const d = seedLength(pieces);
      plan.trims.push({ key, startF: trimStart, endF: first.fromF + d });
      // the seed's in point is right already: the start trim moved it
      if (first.fromF + d < first.toF)
        plan.fixes.push({ kind, track, atF: first.fromF, inTicks: null, endF: first.toF });
      for (const p of pieces.slice(1)) {
        plan.clones.push({ key, offsetF: p.fromF - first.fromF });
        plan.fixes.push({
          kind,
          track,
          atF: p.fromF,
          inTicks: inAt(p.fromF),
          endF: p.toF > p.fromF + d ? p.toF : null,
        });
      }
    }
    for (const p of pieces) {
      if (p.newStartF !== p.fromF)
        plan.moves.push({ kind, track, atF: p.fromF, byF: p.newStartF - p.fromF });
      plan.expected.push({
        kind,
        track,
        startF: p.newStartF,
        endF: p.newStartF + p.toF - p.fromF,
        inTicks: inAt(p.fromF),
      });
    }
  }
  plan.moves.sort((a, b) => a.kind.localeCompare(b.kind) || a.track - b.track || a.atF - b.atF);
  return plan;
}

/** "V1", "A2": a track as the editor sees it. */
const trackName = (kind: PlanItem["kind"], track: number) =>
  `${kind === "video" ? "V" : "A"}${track + 1}`;

/**
 * Why the cut sequence differs from the plan, in English for the log and the report, or null when every clip
 * is where it should be: same frames, and the in point within half a frame of the source.
 */
export function cutMismatch(
  expected: ExpectedClip[],
  found: (ExpectedClip & { speed?: number })[],
  ticksPerFrame: number,
): string | null {
  const group = <T extends ExpectedClip>(list: T[]) => {
    const by = new Map<string, T[]>();
    for (const c of list) {
      const k = trackName(c.kind, c.track);
      by.set(k, [...(by.get(k) ?? []), c]);
    }
    for (const l of by.values()) l.sort((a, b) => a.startF - b.startF);
    return by;
  };
  const want = group(expected);
  const have = group(found);
  for (const k of new Set([...want.keys(), ...have.keys()])) {
    const w = want.get(k) ?? [];
    const h = have.get(k) ?? [];
    for (let i = 0; i < Math.max(w.length, h.length); i++) {
      const a = w[i];
      const b = h[i];
      if (!a) return `${k}: an extra clip at frames ${b.startF}-${b.endF}`;
      if (!b) return `${k}: no clip at frames ${a.startF}-${a.endF}`;
      if (a.startF !== b.startF || a.endF !== b.endF)
        return `${k}: expected a clip at frames ${a.startF}-${a.endF}, found ${b.startF}-${b.endF}`;
      const tol = (ticksPerFrame * Math.max(1, b.speed ?? 1)) / 2;
      if (a.inTicks !== null && (b.inTicks === null || Math.abs(a.inTicks - b.inTicks) > tol))
        return `${k}: the clip at frames ${a.startF}-${a.endF} starts at the wrong point of its media`;
    }
  }
  return null;
}

export function createPremiereHost(
  ppro: premierepro,
  uxp: UxpModule,
  fs: FsModule,
  os: OsModule,
): Host {
  const native = (p: string) => nativePathFor(os, p);
  const same = (a: string, b: string) => samePathFor(os, a, b);

  async function activeProject(): Promise<Project> {
    const project = await ppro.Project.getActiveProject();
    if (!project) throw new Error(t("seq.noProject"));
    return project;
  }

  /**
   * The project and sequence each HostSequence was read from. A job keeps working on them when the editor
   * switches to another sequence or another open project meanwhile, as the panel did when it held them itself.
   */
  const known = new Map<string, { project: Project; sequence: Sequence }>();

  /** The Sequence behind a HostSequence: the one it was read from, else found again by guid. */
  async function sequenceOf(seq: HostSequence): Promise<{ project: Project; sequence: Sequence }> {
    const kept = known.get(seq.id);
    if (kept) {
      // still in its project: not deleted, and the project not closed
      const there = await kept.project.getSequences().catch(() => []);
      if (there.some((s) => s.guid.toString() === seq.id)) return kept;
      known.delete(seq.id);
      throw new Error(t("seq.noSequence"));
    }
    const project = await activeProject();
    const active = await project.getActiveSequence();
    if (active && active.guid.toString() === seq.id) return { project, sequence: active };
    const found = (await project.getSequences()).find((s) => s.guid.toString() === seq.id);
    if (!found) throw new Error(t("seq.noSequence"));
    return { project, sequence: found };
  }

  /** The sequence's frame size. */
  async function sequenceRect(sequence: Sequence): Promise<{ width: number; height: number }> {
    const settings = await sequence.getSettings();
    return premiereCall<Awaited<ReturnType<typeof settings.getVideoFrameRect>>>(
      settings,
      "getVideoFrameRect",
    );
  }

  async function sequenceInfo(sequence: Sequence): Promise<SequenceInfo> {
    const settings = await sequence.getSettings();
    // an older Premiere lacks these: the panel says to update instead of "is not a function"
    const rate = await premiereCall<Awaited<ReturnType<typeof settings.getVideoFrameRate>>>(
      settings,
      "getVideoFrameRate",
    );
    const rect = await premiereCall<Awaited<ReturnType<typeof settings.getVideoFrameRect>>>(
      settings,
      "getVideoFrameRect",
    );
    const inPoint = await sequence.getInPoint();
    const outPoint = await sequence.getOutPoint();
    return {
      name: await sequence.name,
      inSeconds: inPoint.seconds,
      outSeconds: outPoint.seconds,
      fps: formatRational(
        rationalFps(ppro.TickTime.TIME_ONE_SECOND.ticksNumber, rate.ticksPerFrame),
      ),
      fpsValue: rate.value,
      width: rect.width,
      height: rect.height,
      videoTracks: await sequence.getVideoTrackCount(),
      audioTracks: await sequence.getAudioTrackCount(),
    };
  }

  /** The media file behind a clip, or null for a clip without one (title, adjustment layer). */
  async function pathOf(item: Clip): Promise<string | null> {
    try {
      return await ppro.ClipProjectItem.cast(await item.getProjectItem()).getMediaFilePath();
    } catch {
      return null;
    }
  }

  /** The clips on each video track, by 0-based track index. */
  async function videoClips(sequence: Sequence): Promise<Clip[][]> {
    const tracks: Clip[][] = [];
    for (let i = 0; i < (await sequence.getVideoTrackCount()); i++)
      tracks.push(
        (await sequence.getVideoTrack(i)).getTrackItems(
          ppro.Constants.TrackItemType.CLIP,
          false,
        ) as unknown as Clip[],
      );
    return tracks;
  }

  /** `seconds` moved to the nearest frame of the sequence. */
  async function onFrame(sequence: Sequence, seconds: number): Promise<number> {
    const settings = await sequence.getSettings();
    const rate = await premiereCall<Awaited<ReturnType<typeof settings.getVideoFrameRate>>>(
      settings,
      "getVideoFrameRate",
    );
    const frameS = rate.ticksPerFrame / ppro.TickTime.TIME_ONE_SECOND.ticksNumber;
    return frameS > 0
      ? (Math.round(seconds / frameS) * rate.ticksPerFrame) /
          ppro.TickTime.TIME_ONE_SECOND.ticksNumber
      : seconds;
  }

  /** The clips of `mediaPath` among `clips` that start at `atS` and last `durationS`, each within a frame. */
  async function captionClips(
    sequence: Sequence,
    clips: Clip[],
    mediaPath: string,
    atS: number,
    durationS: number,
  ): Promise<Clip[]> {
    const settings = await sequence.getSettings();
    const rate = await premiereCall<Awaited<ReturnType<typeof settings.getVideoFrameRate>>>(
      settings,
      "getVideoFrameRate",
    );
    const frame = 1 / rate.value;
    const found: Clip[] = [];
    for (const item of clips) {
      const path = await pathOf(item);
      if (!path || !same(path, mediaPath)) continue;
      const start = (await item.getStartTime()).seconds;
      const end = (await item.getEndTime()).seconds;
      if (Math.abs(start - atS) < frame && Math.abs(end - start - durationS) < frame)
        found.push(item);
    }
    return found;
  }

  /** True when the track holds one of our inserts (or its effects) that overlaps [startS, endS]. */
  async function holdsOurInsert(track: Mutable, startS: number, endS: number): Promise<boolean> {
    for (const item of track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)) {
      const start = (await item.getStartTime()).seconds;
      const end = (await item.getEndTime()).seconds;
      if (end <= startS || start >= endS) continue;
      try {
        const path = await ppro.ClipProjectItem.cast(
          await item.getProjectItem(),
        ).getMediaFilePath();
        if (isOurInsert(path)) return true;
      } catch {
        // a clip without a media file (title, adjustment layer) is the editor's own
      }
    }
    return false;
  }

  /**
   * Runs `fn` with the tracks that hold an earlier Kilnframe insert or its sound effects over [startS, endS]
   * switched off, then switches them back on whatever happens. The frames, the picture and the speech of the
   * range must be the editor's own, not what the last run made (9 Oct 2026: a second run over the same range
   * saw only the first run's whiteboard and planned every scene fullscreen). Tracks already off stay off.
   */
  async function withoutOurInserts<T>(
    sequence: Sequence,
    startS: number,
    endS: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    const tracks: Mutable[] = [];
    for (let i = 0; i < (await sequence.getVideoTrackCount()); i++)
      tracks.push((await sequence.getVideoTrack(i)) as unknown as Mutable);
    for (let i = 0; i < (await sequence.getAudioTrackCount()); i++)
      tracks.push((await sequence.getAudioTrack(i)) as unknown as Mutable);
    const hidden: Mutable[] = [];
    try {
      for (const track of tracks) {
        if (await track.isMuted()) continue;
        if ((await holdsOurInsert(track, startS, endS)) && (await track.setMute(true)))
          hidden.push(track);
      }
      return await fn();
    } finally {
      for (const track of hidden) await track.setMute(false);
    }
  }

  /**
   * 0-based unmuted audio tracks with a clip over [startS, endS) whose file is neither one Kilnframe delivered
   * nor an earlier voice fix take.
   */
  async function speechTracksAt(sequence: Sequence, startS: number, endS: number) {
    const found: number[] = [];
    for (let i = 0; i < (await sequence.getAudioTrackCount()); i++) {
      const track = (await sequence.getAudioTrack(i)) as unknown as Mutable;
      if (await track.isMuted()) continue;
      for (const item of track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)) {
        const start = (await item.getStartTime()).seconds;
        const end = (await item.getEndTime()).seconds;
        if (end <= startS || start >= endS) continue;
        const path = await pathOf(item);
        // a clip without a media file (a nested sequence) is the editor's own
        if (!path || !(isOurInsert(path) || isVoiceFixTake(path))) {
          found.push(i);
          break;
        }
      }
    }
    return found;
  }

  /**
   * Runs `fn` with every audio track but `index` muted, then unmutes them whatever happens. Tracks already muted
   * stay muted. Not isolated when Premiere refused or failed to mute one: `fn` still runs.
   */
  async function withOnlyAudioTrack<T>(
    sequence: Sequence,
    index: number,
    fn: () => Promise<T>,
  ): Promise<{ result: T; isolated: boolean }> {
    const hidden: Mutable[] = [];
    let isolated = true;
    /** Unmutes every track muted here; the first failure, after trying them all. */
    const restore = async () => {
      let failure: unknown = null;
      for (const track of hidden)
        try {
          if (!(await track.setMute(false))) failure ??= new Error(t("premiere.unmuteFailed"));
        } catch (err) {
          failure ??= err;
        }
      return failure;
    };
    let result: T;
    try {
      for (let i = 0; i < (await sequence.getAudioTrackCount()); i++) {
        if (i === index) continue;
        let track: Mutable | undefined;
        try {
          track = (await sequence.getAudioTrack(i)) as unknown as Mutable;
          if (await track.isMuted()) continue;
          if (await track.setMute(true)) hidden.push(track);
          else isolated = false;
        } catch {
          isolated = false;
          // the mute may have applied before the call threw: unmute it afterwards too
          if (track && (await track.isMuted().catch(() => false))) hidden.push(track);
        }
      }
      result = await fn();
    } catch (err) {
      // the export's own error is the one the editor needs; one from unmuting would hide it
      await restore();
      throw err;
    }
    const failure = await restore();
    if (failure) throw failure;
    return { result, isolated };
  }

  /**
   * The range's picture as a small H.264 file, so the preview shows the insert over the real footage. Only
   * the range is encoded: the work area is set to it for the export and put back afterwards, whatever
   * happens. Uses Premiere's own "Match Source, Low bitrate" preset (companion findPreviewPreset).
   */
  async function exportRangePicture(
    sequence: Sequence,
    startS: number,
    endS: number,
    outputPath: string,
    presetPath: string,
  ): Promise<boolean> {
    const area = ppro.WorkAreaUtils;
    const before = {
      in: area.getWorkAreaInPoint(sequence),
      out: area.getWorkAreaOutPoint(sequence),
    };
    try {
      area.setWorkAreaInOutPoints(
        sequence,
        ppro.TickTime.createWithSeconds(startS),
        ppro.TickTime.createWithSeconds(endS),
      );
      return await ppro.EncoderManager.getManager()
        .exportSequence(
          sequence,
          ppro.Constants.ExportType.IMMEDIATELY,
          native(outputPath),
          native(presetPath),
          false,
        )
        .catch((err: unknown) => {
          throw exportError(err);
        });
    } finally {
      area.setWorkAreaInOutPoints(sequence, before.in, before.out);
    }
  }

  async function findOrCreateBin(project: Project, name: string): Promise<ProjectItem> {
    const root = (await project.getRootItem()) as FolderItem;
    const existing = (await root.getItems()).find((i) => i.name === name);
    if (existing) return existing;
    project.lockedAccess(() => {
      project.executeTransaction(
        (compound) => compound.addAction(root.createBinAction(name, false)),
        t("premiere.undoBin"),
      );
    });
    const created = (await root.getItems()).find((i) => i.name === name);
    if (!created) throw new Error(t("premiere.binFailed", { name }));
    return created;
  }

  /** Imports a file into the "Kilnframe" bin and returns its project item. */
  async function importToBin(project: Project, path: string): Promise<ProjectItem> {
    const bin = await findOrCreateBin(project, "Kilnframe");
    const ok = await project.importFiles([native(path)], true, bin, false);
    if (!ok) throw new Error(t("premiere.importFailed", { path }));
    // items from getItems() come back as plain ProjectItems; a bin has to be cast before it can be listed
    const items = await ppro.FolderItem.cast(bin).getItems();
    for (const item of items) {
      const clip = ppro.ClipProjectItem.cast(item as never) as unknown as {
        getMediaFilePath?: () => Promise<string>;
      };
      if (clip.getMediaFilePath && same(await clip.getMediaFilePath(), path)) return item;
    }
    throw new Error(t("premiere.importMissing", { path }));
  }

  /** Overwrites the item at the given time on the given 0-based tracks, as one undoable step. */
  function placeItem(
    project: Project,
    sequence: Sequence,
    item: ProjectItem,
    seconds: number,
    videoTrack: number,
    audioTrack: number,
  ): boolean {
    const editor = ppro.SequenceEditor.getEditor(sequence);
    let ok = false;
    project.lockedAccess(() => {
      ok = project.executeTransaction(
        (compound) =>
          compound.addAction(
            editor.createOverwriteItemAction(
              item,
              ppro.TickTime.createWithSeconds(seconds),
              videoTrack,
              audioTrack,
            ),
          ),
        t("premiere.undoPlace"),
      );
    });
    return ok;
  }

  /**
   * Scales the clip of `mediaPath` that starts at `atS` on the 0-based video track up by `scale` (frame.ts
   * insertScale: a 4K clip on a 6K or 8K sequence), through its Motion effect's Scale, as one undoable step.
   * Adobe's premiere-api sample sets a value the same way (keyframe.ts: component 1, param 1, createKeyframe
   * and createSetValueAction). False when the clip or its Scale could not be found or set: the caller says so.
   */
  async function scaleClip(
    project: Project,
    sequence: Sequence,
    videoTrack: number,
    atS: number,
    mediaPath: string,
    scale: number,
  ): Promise<boolean> {
    if (scale <= 1) return true;
    try {
      let clip: Clip | null = null;
      for (const c of (await videoClips(sequence))[videoTrack] ?? []) {
        const path = await pathOf(c);
        if (
          path &&
          same(path, mediaPath) &&
          Math.abs((await c.getStartTime()).seconds - atS) < 0.05
        )
          clip = c;
      }
      if (!clip) return false;
      const chain = await (
        clip as unknown as { getComponentChain(): Promise<Effects> }
      ).getComponentChain();
      let motion: ReturnType<Effects["getComponentAtIndex"]> | null = null;
      for (let i = 0; i < chain.getComponentCount() && !motion; i++) {
        const c = chain.getComponentAtIndex(i);
        if ((await c.getMatchName()) === "AE.ADBE Motion") motion = c;
      }
      if (!motion) return false;
      // Motion's parameters: 0 Position, 1 Scale (Premiere's own order, the sample's param 1)
      const param = motion.getParam(1);
      let ok = false;
      project.lockedAccess(() => {
        ok = project.executeTransaction(
          (compound) =>
            compound.addAction(
              param.createSetValueAction(param.createKeyframe(scale * 100), true) as never,
            ),
          t("premiere.undoScale"),
        );
      });
      return ok;
    } catch {
      return false;
    }
  }

  /**
   * The first track above everything in use: an empty video track just over the highest one holding a clip
   * (so the insert stays on top), and an empty audio track after the last used one. The track count, which
   * makes Premiere add a new track, when there is no empty one there.
   */
  async function freeTracks(sequence: Sequence): Promise<PlaceResult> {
    const CLIP = ppro.Constants.TrackItemType.CLIP;
    const above = async (count: number, used: (i: number) => Promise<boolean>) => {
      let top = -1;
      for (let i = 0; i < count; i++) if (await used(i)) top = i;
      return top + 1;
    };
    const videoTrack = await above(
      await sequence.getVideoTrackCount(),
      async (i) => (await sequence.getVideoTrack(i)).getTrackItems(CLIP, false).length > 0,
    );
    const audioTrack = await above(
      await sequence.getAudioTrackCount(),
      async (i) => (await sequence.getAudioTrack(i)).getTrackItems(CLIP, false).length > 0,
    );
    return { videoTrack, audioTrack };
  }

  /**
   * Imports the delivered insert (and its sound effect mix) and lays them over the range: the clip's in/out
   * cut away the handles, so the editor sees exactly the range and can still trim into the handles. Video goes
   * on a new top video track, sound on a new audio track, each import as one undoable step.
   */
  async function placeInsert(
    project: Project,
    sequence: Sequence,
    files: { video: string; sfx: string | null },
    at: number,
    handlesSeconds: number,
    durationSeconds: number,
    tracks?: PlaceResult,
  ): Promise<PlaceResult> {
    // a long range's parts start at sentence ends in milliseconds; off the frame grid they could leave a
    // frame's gap or overlap between parts (Resolve and FilmCraft round to frames in their bridges)
    at = await onFrame(sequence, at);
    const { videoTrack, audioTrack } = tracks ?? (await freeTracks(sequence));
    const trim = (item: ProjectItem) => {
      const clip = ppro.ClipProjectItem.cast(item);
      project.lockedAccess(() => {
        project.executeTransaction(
          (compound) =>
            compound.addAction(
              clip.createSetInOutPointsAction(
                ppro.TickTime.createWithSeconds(handlesSeconds),
                ppro.TickTime.createWithSeconds(handlesSeconds + durationSeconds),
              ),
            ),
          t("premiere.undoTrim"),
        );
      });
    };
    const video = await importToBin(project, files.video);
    trim(video);
    if (!placeItem(project, sequence, video, at, videoTrack, audioTrack))
      throw new Error(t("premiere.placeFailed"));
    const rect = await sequenceRect(sequence);
    const scale = insertScale(rect.width, rect.height);
    const scaled = await scaleClip(project, sequence, videoTrack, at, files.video, scale);
    if (files.sfx) {
      const sfx = await importToBin(project, files.sfx);
      trim(sfx);
      if (!placeItem(project, sequence, sfx, at, videoTrack, audioTrack))
        throw new Error(t("premiere.sfxFailed"));
    }
    return { videoTrack, audioTrack, ...(scaled ? {} : { scaleByHand: Math.round(scale * 100) }) };
  }

  /**
   * Story mode: a new sequence with the template sequence's settings (frame size, rate, audio), holding the
   * narration from 0 on A1; it becomes the active sequence so the normal flow animates over it.
   */
  async function createStorySequence(
    project: Project,
    template: Sequence,
    name: string,
    audioPath: string,
    /** The music bed, placed on the second audio track under the narration. */
    musicPath: string | null,
    /** A frame shape for the new sequence; its short side stays the template's. Missing: the template's. */
    format?: "landscape" | "portrait" | "square",
  ): Promise<void> {
    const audio = await importToBin(project, audioPath);
    const sequence = await project.createSequence(name);
    const settings = await template.getSettings();
    if (format) {
      const rect = await settings.getVideoFrameRect();
      const size = frameFor(format, rect.width, rect.height);
      const next = new ppro.RectF();
      next.width = size.width;
      next.height = size.height;
      if (!(await settings.setVideoFrameRect(next))) throw new Error(t("premiere.formatFailed"));
      await settings.setPreviewFrameRect(next);
    }
    project.lockedAccess(() => {
      project.executeTransaction(
        (compound) => compound.addAction(sequence.createSetSettingsAction(settings)),
        t("premiere.undoStory"),
      );
    });
    if (!placeItem(project, sequence, audio, 0, 0, 0)) throw new Error(t("premiere.storyFailed"));
    if (musicPath) {
      const music = await importToBin(project, musicPath);
      if (!placeItem(project, sequence, music, 0, 0, 1)) throw new Error(t("premiere.musicFailed"));
    }
    await project.openSequence(sequence);
    await project.setActiveSequence(sequence);
  }

  type TrackItem = VideoClipTrackItem | AudioClipTrackItem;
  interface ReadClip {
    item: TrackItem;
    info: CutClipInfo;
  }

  const ticksOf = (time: { ticks?: string; seconds: number }) =>
    time.ticks !== undefined
      ? Number(time.ticks)
      : time.seconds * ppro.TickTime.TIME_ONE_SECOND.ticksNumber;

  /** Runs one transaction (one undo step); throws, naming the step, when Premiere refuses it. */
  function runStep(project: Project, step: string, add: (c: CompoundAction) => void): void {
    let ok = false;
    project.lockedAccess(() => {
      // new key for the tab's locale files; until it is there t() shows the key itself
      ok = project.executeTransaction(add, t("premiere.undoPauses"));
    });
    if (!ok) throw new Error(`Premiere refused the step "${step}"`);
  }

  /** A copy of `sequence`: the sequence whose guid was not there before the clone action. */
  async function cloneSequence(project: Project, sequence: Sequence): Promise<Sequence> {
    const before = new Set((await project.getSequences()).map((s) => s.guid.toString()));
    const added = async () =>
      (await project.getSequences()).filter((s) => !before.has(s.guid.toString()));
    runStep(project, "copy the sequence", (c) => c.addAction(sequence.createCloneAction()));
    const clone = (await added())[0];
    if (!clone) {
      // the transaction went through: whatever it made is the copy, and must not stay behind
      for (const s of await added()) await project.deleteSequence(s).catch(() => false);
      throw new Error("The copy of the sequence was not found");
    }
    return clone;
  }

  /**
   * Transitions on `sequence` that touch a cut (an edge a pause is cut at, or a clip that goes): a trim or a
   * move next to one may be refused, so they come off the copy first.
   */
  async function transitionsAtCuts(sequence: Sequence, cuts: FrameCut[], tpf: number) {
    const TRANSITION = ppro.Constants.TrackItemType.TRANSITION;
    const frameOf = (t: { ticks?: string; seconds: number }) => Math.round(ticksOf(t) / tpf);
    const found: TrackItem[] = [];
    const scan = async (items: TrackItem[]) => {
      for (const item of items) {
        const a = frameOf(await item.getStartTime());
        const b = frameOf(await item.getEndTime());
        if (cuts.some((c) => a <= c.endF && b >= c.startF)) found.push(item);
      }
    };
    for (let i = 0; i < (await sequence.getVideoTrackCount()); i++)
      await scan((await sequence.getVideoTrack(i)).getTrackItems(TRANSITION, false));
    for (let i = 0; i < (await sequence.getAudioTrackCount()); i++)
      await scan((await sequence.getAudioTrack(i)).getTrackItems(TRANSITION, false));
    return found;
  }

  /** Every clip of every track of `sequence`, in sequence frames. */
  async function readItems(sequence: Sequence, ticksPerFrame: number): Promise<ReadClip[]> {
    const frameOf = (t: { ticks?: string; seconds: number }) =>
      Math.round(ticksOf(t) / ticksPerFrame);
    const CLIP = ppro.Constants.TrackItemType.CLIP;
    const out: ReadClip[] = [];
    const read = async (kind: PlanItem["kind"], track: number, items: TrackItem[]) => {
      for (const [i, item] of items.entries()) {
        const inTicks = await item.getInPoint().then(ticksOf, () => null);
        out.push({
          item,
          info: {
            plan: {
              key: `${kind}:${track}:${i}`,
              kind,
              track,
              startF: frameOf(await item.getStartTime()),
              endF: frameOf(await item.getEndTime()),
            },
            inTicks,
            // a title or a graphic may not say: it has no speed
            speed: await item.getSpeed().catch(() => 1),
            reversed: Boolean(await item.isSpeedReversed().catch(() => 0)),
          },
        });
      }
    };
    for (let i = 0; i < (await sequence.getVideoTrackCount()); i++)
      await read("video", i, (await sequence.getVideoTrack(i)).getTrackItems(CLIP, false));
    for (let i = 0; i < (await sequence.getAudioTrackCount()); i++)
      await read("audio", i, (await sequence.getAudioTrack(i)).getTrackItems(CLIP, false));
    return out;
  }

  /** A cut refused for a reason the editor can act on: its own words reach the panel. */
  class CutRefused extends Error {}

  /**
   * Remove Pauses: a copy of the sequence with every track cut at the pauses and closed up, made the active
   * sequence. The editor's sequence is never touched; the copy is deleted again when any step fails or the cut
   * does not read back as planned (a locked track, say: Premiere does not tell a plugin about locks).
   */
  async function cutToNewSequence(
    project: Project,
    sequence: Sequence,
    cuts: TimelineCut[],
    name: string,
    onProgress?: (done: number, total: number) => void,
  ): Promise<CutSequenceResult> {
    const TOTAL = 7;
    const settings = await sequence.getSettings();
    const rate = await premiereCall<Awaited<ReturnType<typeof settings.getVideoFrameRate>>>(
      settings,
      "getVideoFrameRate",
    );
    const tpf = rate.ticksPerFrame;
    // whole ticks: seconds at 29.97 fps would land a hair off the frame
    const at = (frames: number) => ppro.TickTime.createWithTicks(String(Math.round(frames * tpf)));
    let clone: Sequence | null = null;
    // the step a failure came from, for the log
    let stage = "copy the sequence";
    try {
      clone = await cloneSequence(project, sequence);
      onProgress?.(1, TOTAL);
      const copy = clone;
      const editor = ppro.SequenceEditor.getEditor(copy);
      const endF = Math.round(ticksOf(await copy.getEndTime()) / tpf);
      const frames = frameCuts(cuts, ppro.TickTime.TIME_ONE_SECOND.ticksNumber / tpf, endF);
      stage = "name the copy";
      // a sequence is renamed through its project item
      const projectItem = await copy.getProjectItem();
      runStep(project, "name the copy", (c) => c.addAction(projectItem.createSetNameAction(name)));

      // a transaction leaves the clip objects read before it no longer valid ("The script object is no longer
      // valid", 11 Nov 2026): the transitions come off first, the clips are read after
      stage = "remove transitions";
      // 0: transitions at the cuts come off the copy (the pieces meet in hard cuts there); when Premiere will
      // not take them off, the cut is refused before any clip is touched
      const transitions = await transitionsAtCuts(copy, frames, tpf);
      if (transitions.length) {
        try {
          withSelection(transitions, (selection) =>
            runStep(project, "remove transitions", (c) =>
              c.addAction(
                editor.createRemoveItemsAction(
                  selection,
                  false,
                  ppro.Constants.MediaType.ANY,
                  false,
                ),
              ),
            ),
          );
        } catch {
          /* checked below */
        }
        if ((await transitionsAtCuts(copy, frames, tpf)).length)
          throw new CutRefused(t("pauses.transitions"));
      }

      stage = "read the clips";
      const read = await readItems(copy, tpf);
      const plan = planPremiereCut(
        read.map((r) => r.info),
        frames,
        tpf,
      );
      const byKey = new Map(read.map((r) => [r.info.plan.key, r]));
      const item = (key: string) => (byKey.get(key) as ReadClip).item;

      stage = "remove clips";
      // A: clips with nothing left. One selection per media type: an ANY removal may take a linked partner
      // that still has pieces. The selections live only inside their callbacks, nothing async in them
      if (plan.remove.length) {
        const of = (kind: PlanItem["kind"]) =>
          plan.remove.filter((key) => byKey.get(key)?.info.plan.kind === kind).map(item);
        const video = of("video");
        const audio = of("audio");
        withSelection(video, (videoSel) =>
          withSelection(audio, (audioSel) =>
            runStep(project, "remove clips", (c) => {
              if (video.length)
                c.addAction(
                  editor.createRemoveItemsAction(
                    videoSel,
                    false,
                    ppro.Constants.MediaType.VIDEO,
                    false,
                  ),
                );
              if (audio.length)
                c.addAction(
                  editor.createRemoveItemsAction(
                    audioSel,
                    false,
                    ppro.Constants.MediaType.AUDIO,
                    false,
                  ),
                );
            }),
          ),
        );
      }
      onProgress?.(2, TOTAL);

      stage = "trim to the seed";
      // B: trim to the seed; the end first, so the clip only ever shrinks. A start trim moves the in point too
      if (plan.trims.length)
        runStep(project, "trim clips", (c) => {
          for (const tr of plan.trims) {
            if (tr.endF !== null) c.addAction(item(tr.key).createSetEndAction(at(tr.endF)));
            if (tr.startF !== null) c.addAction(item(tr.key).createSetStartAction(at(tr.startF)));
          }
        });
      onProgress?.(3, TOTAL);

      stage = "copy the pieces";
      // C: copies of each seed into its further pieces, on its own track (alignToVideo for an audio clip,
      // which lands the same way); an overwrite, but only over the clip's own emptied span
      if (plan.clones.length)
        runStep(project, "copy clips", (c) => {
          for (const cl of plan.clones) {
            const seed = byKey.get(cl.key) as ReadClip;
            const audio = seed.info.plan.kind === "audio";
            c.addAction(
              editor.createCloneTrackItemAction(seed.item, at(cl.offsetF), 0, 0, audio, false),
            );
          }
        });
      onProgress?.(4, TOTAL);

      // seeds and copies are found again by track and start frame, unique on a track
      const placed = new Map<string, TrackItem>();
      const atKey = (c: ClipAt) => `${c.kind}:${c.track}:${c.atF}`;
      for (const r of await readItems(copy, tpf))
        placed.set(atKey({ ...r.info.plan, atF: r.info.plan.startF }), r.item);
      const find = (c: ClipAt) => {
        const found = placed.get(atKey(c));
        if (!found) throw new Error(`${trackName(c.kind, c.track)}: no clip at frame ${c.atF}`);
        return found;
      };

      stage = "set in points and ends";
      // D: each copy's in point, then every piece grows to its end into its own emptied span
      if (plan.fixes.length) {
        const fixes = plan.fixes.map((f) => ({ f, it: find(f) }));
        runStep(project, "set in and end points", (c) => {
          for (const { f, it } of fixes) {
            if (f.inTicks !== null)
              c.addAction(
                it.createSetInPointAction(ppro.TickTime.createWithTicks(String(f.inTicks))),
              );
            if (f.endF !== null) c.addAction(it.createSetEndAction(at(f.endF)));
          }
        });
      }
      onProgress?.(5, TOTAL);

      stage = "move the pieces";
      // E: a move is a relative shift and does not overwrite; left to right, each piece only moves into
      // space already emptied
      if (plan.moves.length) {
        const moves = plan.moves.map((m) => ({ m, it: find(m) }));
        runStep(project, "close the pauses", (c) => {
          for (const { m, it } of moves) c.addAction(it.createMoveAction(at(m.byF)));
        });
      }
      onProgress?.(6, TOTAL);

      const after = (await readItems(copy, tpf)).map((r) => ({
        ...r.info.plan,
        inTicks: r.info.inTicks,
        speed: r.info.speed,
      }));
      stage = "check the cut";
      const why = cutMismatch(plan.expected, after, tpf);
      if (why) throw new Error(`The cut sequence differs from the plan: ${why}`);

      // the copy's markers and In/Out were cloned at their old times: they follow their content
      stage = "move markers, In and Out";
      await followMarks(project, copy, frames, tpf);
      onProgress?.(TOTAL, TOTAL);

      await project.openSequence(copy);
      await project.setActiveSequence(copy);
      const id = copy.guid.toString();
      known.set(id, { project, sequence: copy });
      return { id, name, leftOut: plan.leftOut, rebuilt: false };
    } catch (err) {
      if (clone) await project.deleteSequence(clone).catch(() => false);
      if (err instanceof CutRefused) throw new Error(err.message, { cause: err });
      // the reason (which clip, which frames) goes with it for the log; the editor reads that nothing was lost
      // the step goes on the reason, which the tab logs from `cause`
      if (err instanceof Error) err.message = `${stage}: ${err.message}`;
      throw new Error(t("premiere.cutFailed"), { cause: err });
    }
  }

  /** Runs `fn` with a selection of `items`; it is valid only inside the callback. Rethrows what `fn` threw. */
  function withSelection(items: TrackItem[], fn: (selection: TrackItemSelection) => void): void {
    let failure: unknown = null;
    ppro.TrackItemSelection.createEmptySelection((selection) => {
      try {
        for (const it of items) selection.addItem(it, true);
        fn(selection);
      } catch (err) {
        failure = err;
      }
    });
    if (failure) throw failure;
  }

  /**
   * Sequence markers and the In/Out on the cut copy: each moves left by the frames cut before it; a marker
   * inside a cut goes with it, an In or Out inside one goes to its edge.
   */
  async function followMarks(
    project: Project,
    copy: Sequence,
    frames: FrameCut[],
    tpf: number,
  ): Promise<void> {
    if (!frames.length) return;
    const frameOf = (t: { ticks?: string; seconds: number }) => Math.round(ticksOf(t) / tpf);
    const at = (f: number) => ppro.TickTime.createWithTicks(String(Math.round(f * tpf)));
    const markers = await ppro.Markers.getMarkers(copy);
    const moves: Action[] = [];
    for (const m of markers.getMarkers()) {
      const f = frameOf(m.getStart());
      if (frames.some((c) => f >= c.startF && f < c.endF))
        moves.push(markers.createRemoveMarkerAction(m));
      else if (shiftAt(frames, f) > 0)
        moves.push(markers.createMoveMarkerAction(m, at(newEndF(f, frames))));
    }
    if (moves.length) runStep(project, "move markers", (c) => moves.forEach((a) => c.addAction(a)));
    // an unset In or Out reads far before the start (range.ts)
    const inPoint = await copy.getInPoint();
    const outPoint = await copy.getOutPoint();
    const inF = inPoint.seconds > -1000 ? frameOf(inPoint) : null;
    const outF = outPoint.seconds > -1000 ? frameOf(outPoint) : null;
    const marks: Action[] = [];
    if (inF !== null && shiftAt(frames, inF) > 0)
      marks.push(copy.createSetInPointAction(at(newEndF(inF, frames))));
    if (outF !== null && shiftAt(frames, outF) > 0)
      marks.push(copy.createSetOutPointAction(at(newEndF(outF, frames))));
    if (marks.length)
      runStep(project, "move In and Out", (c) => marks.forEach((a) => c.addAction(a)));
  }

  return {
    kind: "premiere",
    async currentSequence() {
      const project = await activeProject();
      const sequence = await project.getActiveSequence();
      if (!sequence) throw new Error(t("seq.noSequence"));
      const info = await sequenceInfo(sequence);
      const end = await sequence.getEndTime();
      known.set(sequence.guid.toString(), { project, sequence });
      return {
        id: sequence.guid.toString(),
        name: info.name,
        projectPath: withoutLongPathPrefix(project.path),
        fps: info.fps,
        fpsValue: info.fpsValue,
        width: info.width,
        height: info.height,
        inSeconds: info.inSeconds,
        outSeconds: info.outSeconds,
        endSeconds: end.seconds,
        videoTracks: info.videoTracks,
        audioTracks: info.audioTracks,
      };
    },
    async quickRange() {
      const project = await activeProject();
      const sequence = await project.getActiveSequence();
      if (!sequence) throw new Error(t("seq.noSequence"));
      const [inPoint, outPoint, end] = await Promise.all([
        sequence.getInPoint(),
        sequence.getOutPoint(),
        sequence.getEndTime(),
      ]);
      return {
        id: sequence.guid.toString(),
        inSeconds: inPoint.seconds,
        outSeconds: outPoint.seconds,
        endSeconds: end.seconds,
      };
    },
    async exportFrame(seq, seconds, dir, name, width, height) {
      const { sequence } = await sequenceOf(seq);
      return ppro.Exporter.exportSequenceFrame(
        sequence,
        ppro.TickTime.createWithSeconds(seconds),
        name,
        native(dir),
        width,
        height,
      );
    },
    async exportRangeAudio(seq, _startS, _endS, file, { wavPreset }) {
      // the whole sequence: the companion cuts the range with FFmpeg (the docs do not say whether in/out is used)
      const { sequence } = await sequenceOf(seq);
      const ok = await ppro.EncoderManager.getManager()
        .exportSequence(
          sequence,
          ppro.Constants.ExportType.IMMEDIATELY,
          native(file),
          native(wavPreset),
          true,
        )
        .catch((err: unknown) => {
          throw exportError(err);
        });
      return { ok, offsetSeconds: 0 };
    },
    async exportRangePicture(seq, startS, endS, file, { previewPreset }) {
      const { sequence } = await sequenceOf(seq);
      return exportRangePicture(sequence, startS, endS, file, previewPreset);
    },
    async withoutOurInserts(seq, startS, endS, fn) {
      const { sequence } = await sequenceOf(seq);
      return withoutOurInserts(sequence, startS, endS, fn);
    },
    async speechTracksAt(seq, startS, endS) {
      const { sequence } = await sequenceOf(seq);
      return speechTracksAt(sequence, startS, endS);
    },
    async withOnlyAudioTrack(seq, track, fn) {
      const { sequence } = await sequenceOf(seq);
      return withOnlyAudioTrack(sequence, track, fn);
    },
    async placeInsert(seq, files, atS, handlesS, durationS, tracks) {
      const { project, sequence } = await sequenceOf(seq);
      return placeInsert(project, sequence, files, atS, handlesS, durationS, tracks);
    },
    async placeAudioClips(seq, clips) {
      const { project, sequence } = await sequenceOf(seq);
      const { videoTrack, audioTrack } = await freeTracks(sequence);
      // the clips are as long as their sections already: placed whole, no in or out points
      for (const c of clips) {
        const item = await importToBin(project, c.file);
        if (!placeItem(project, sequence, item, c.atS, videoTrack, audioTrack))
          throw new Error(t("premiere.placeFailed"));
      }
      return { audioTrack };
    },
    async ourInsertSpans(seq) {
      const { sequence } = await sequenceOf(seq);
      const spans: { startS: number; endS: number }[] = [];
      for (const clips of await videoClips(sequence))
        for (const item of clips) {
          const path = await pathOf(item);
          if (path && isOurAnimation(path))
            spans.push({
              startS: (await item.getStartTime()).seconds,
              endS: (await item.getEndTime()).seconds,
            });
        }
      return spans.sort((a, b) => a.startS - b.startS);
    },
    async findCaptionClip(seq, mediaPath, atS, durationS) {
      const { sequence } = await sequenceOf(seq);
      const tracks = await videoClips(sequence);
      for (const [i, clips] of tracks.entries())
        if ((await captionClips(sequence, clips, mediaPath, atS, durationS)).length)
          return { videoTrack: i };
      return null;
    },
    // SequenceEditor.createRemoveItemsAction(selection, ripple, mediaType, shiftOverlapping) takes the clips of a
    // TrackItemSelection off; createOverwriteItemAction(item, time, videoTrack, audioTrack) places the new clip.
    // The selection comes from TrackItemSelection.createEmptySelection(callback) and addItem(), and is valid only
    // inside that callback, with nothing asynchronous in it: so the whole transaction runs there, one undo step.
    // developer.adobe.com/premiere-pro/uxp/ppro_reference/classes/sequenceeditor/ and
    // developer.adobe.com/premiere-pro/uxp/ppro_reference/classes/trackitemselection/
    async replaceCaptionClip(seq, before, file, atS, durationS, videoTrack) {
      const { project, sequence } = await sequenceOf(seq);
      const clips = (await videoClips(sequence))[videoTrack] ?? [];
      const old = await captionClips(sequence, clips, before.path, before.atS, before.durationS);
      // moved, trimmed or gone since it was found: never overwrite whatever lies there now
      if (!old.length) return false;
      const item = await importToBin(project, file);
      // a caption clip has no sound; an empty audio track all the same, so nothing lands on the editor's own
      const { audioTrack } = await freeTracks(sequence);
      const editor = ppro.SequenceEditor.getEditor(sequence);
      let ok = false;
      const replace = (selection: TrackItemSelection) =>
        project.lockedAccess(() => {
          ok = project.executeTransaction((compound) => {
            compound.addAction(
              editor.createRemoveItemsAction(selection, false, ppro.Constants.MediaType.ANY, false),
            );
            compound.addAction(
              editor.createOverwriteItemAction(
                item,
                ppro.TickTime.createWithSeconds(atS),
                videoTrack,
                audioTrack,
              ),
            );
          }, t("premiere.undoPlace"));
        });
      ppro.TrackItemSelection.createEmptySelection((selection) => {
        for (const clip of old) selection.addItem(clip as never, true);
        replace(selection);
      });
      if (!ok) throw new Error(t("premiere.placeFailed"));
      const rect = await sequenceRect(sequence);
      await scaleClip(
        project,
        sequence,
        videoTrack,
        atS,
        file,
        insertScale(rect.width, rect.height),
      );
      return true;
    },
    async createStorySequence(template, name, narration, music, format) {
      const { project, sequence } = await sequenceOf(template);
      await createStorySequence(project, sequence, name, narration, music, format);
    },
    async cutToNewSequence(seq, cuts, name, onProgress) {
      const { project, sequence } = await sequenceOf(seq);
      return cutToNewSequence(project, sequence, cuts, name, onProgress);
    },
    async pickImages(types) {
      const picked = await uxp.storage.localFileSystem.getFileForOpening({
        allowMultiple: true,
        types,
      });
      const files = !picked ? [] : Array.isArray(picked) ? picked : [picked];
      return files.map((f) => f.nativePath).filter(Boolean);
    },
    async saveFileCopy(source, suggestedName) {
      // UXP's own save dialog; the file it returns may be written to without a further permission
      const ext = suggestedName.split(".").pop() ?? "txt";
      const file = await uxp.storage.localFileSystem.getFileForSaving(suggestedName, {
        types: [ext],
      });
      if (!file) return null;
      await file.write(await fs.readFile(native(source), { encoding: "utf-8" }));
      return file.nativePath;
    },
    async openUrl(url) {
      await uxp.shell.openExternal(url);
    },
    uiLocale: () => uxp.host?.uiLocale ?? null,
    pluginVersion() {
      const v = uxp.versions?.plugin;
      // only a real version string: anything else would break the settings screen
      return typeof v === "string" && /^\d+\.\d+/.test(v) ? v : null;
    },
    readTextFile: (path) => fs.readFile(path, { encoding: "utf-8" }),
    writeTextFile: (path, text) => fs.writeFile(path, text, { encoding: "utf-8" }),
    async fileExists(path) {
      try {
        await fs.lstat(path);
        return true;
      } catch {
        return false;
      }
    },
    homedir() {
      // os.homedir() returns null while a UXP panel is still loading (seen in Premiere 26.5.2)
      const h = os.homedir();
      return h ? h.replace(/\\/g, "/") : null;
    },
    platform: () => (isWin(os) ? "win" : "mac"),
  };
}
