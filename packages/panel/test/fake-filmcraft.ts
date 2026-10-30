// An in-memory FilmCraft behind the client interface: the engine commands the bridge uses, with the shapes
// FilmCraft 0.14.0 answers. Times are ticks from the sequence start; a placed clip starts on the frame asked.
import { NOT_RUNNING, type FilmCraftClient } from "../src/filmcraft/client";
import { TICKS } from "../src/filmcraft/bridge";

export interface FakeClip {
  clip: number;
  item: number;
  start: number;
  end: number;
  startFrame: number;
  endFrame: number;
  sourceIn: number;
}
export interface FakeTrack {
  id: number;
  name: string;
  enabled: boolean;
  locked: boolean;
  items: FakeClip[];
}
export interface FakeSequence {
  id: number;
  name: string;
  duration: number;
  in: number | null;
  out: number | null;
  settings: { frame_rate: { num: number; den: number }; width: number; height: number };
  video: FakeTrack[];
  audio: FakeTrack[];
}

export interface FakeFilmCraftOptions {
  rate?: { num: number; den: number };
  /** In and Out in seconds. */
  inS?: number;
  outS?: number;
  /** The editor's footage on V1/A1, as a clip of this file. */
  footage?: string | null;
}

export function makeFakeFilmCraft(opts: FakeFilmCraftOptions = {}) {
  let nextId = 100;
  const rate = opts.rate ?? { num: 30000, den: 1001 };
  const ticksOf = (frames: number) => Math.round((frames * TICKS * rate.den) / rate.num);
  const framesOf = (ticks: number) => Math.round((ticks * rate.num) / (rate.den * TICKS));
  const track = (name: string, items: FakeClip[] = []): FakeTrack => ({
    id: nextId++,
    name,
    enabled: true,
    locked: false,
    items,
  });

  /** Project items and their files (null: generated media). */
  const media = new Map<number, string | null>();
  const bins: { id: number; name: string; items: number[] }[] = [];
  const clipOf = (item: number, startFrame: number, endFrame: number, sourceIn = 0): FakeClip => ({
    clip: nextId++,
    item,
    start: ticksOf(startFrame),
    end: ticksOf(endFrame),
    startFrame,
    endFrame,
    sourceIn,
  });

  const footageItem = nextId++;
  media.set(footageItem, opts.footage === undefined ? "/Users/ed/Footage/A001.mov" : opts.footage);
  const length = framesOf(30 * TICKS);
  const seq: FakeSequence = {
    id: nextId++,
    name: "Sequence 1",
    duration: ticksOf(length),
    in: opts.inS === undefined ? null : Math.round(opts.inS * TICKS),
    out: opts.outS === undefined ? null : Math.round(opts.outS * TICKS),
    settings: { frame_rate: rate, width: 1920, height: 1080 },
    video: [track("V1", [clipOf(footageItem, 0, length)])],
    audio: [track("A1", [clipOf(footageItem, 0, length)])],
  };
  const sequences = [seq];
  let active: FakeSequence | null = seq;

  const log: { command: string; params: Record<string, unknown> }[] = [];
  const state = {
    sequences,
    media,
    bins,
    log,
    /** Called before each command; throwing from it is FilmCraft failing that command. */
    before: (_command: string, _params: Record<string, unknown>) => undefined as void,
    /** timeline.place lands the clip this many frames off the frame asked. */
    placeOffBy: 0,
    get active() {
      return active;
    },
    /** Our insert placed on a new video track over the footage, with its file. */
    addClip(kind: "video" | "audio", path: string, startS: number, endS: number) {
      const item = nextId++;
      media.set(item, path);
      const t = track(`${kind === "video" ? "V" : "A"}${seq[kind].length + 1}`);
      t.items.push(clipOf(item, framesOf(startS * TICKS), framesOf(endS * TICKS)));
      seq[kind].push(t);
      return t;
    },
    /** All tracks of a sequence, video first. */
    tracks(s: FakeSequence = seq) {
      return [...s.video, ...s.audio];
    },
  };

  const seqOf = (id: unknown) => {
    const s = id === undefined ? active : sequences.find((x) => x.id === id);
    if (!s) throw new Error("no sequence");
    return s;
  };
  const trackOf = (id: unknown) => {
    for (const s of sequences)
      for (const t of [...s.video, ...s.audio]) if (t.id === id) return { s, t };
    throw new Error(`no track ${String(id)}`);
  };

  const commands: Record<string, (p: Record<string, unknown>) => unknown> = {
    "sequence.inspect": (p) => structuredClone(seqOf(p.item)),
    "sequence.open": (p) => {
      active = seqOf(p.item);
      return {};
    },
    "project.inspect": () => ({
      name: "Short Film",
      root: {
        name: "Short Film",
        children: [
          ...bins.map((b) => ({
            id: b.id,
            name: b.name,
            children: b.items.map((i) => ({ item: i, name: String(media.get(i)) })),
          })),
          ...sequences.map((s) => ({ item: s.id, name: s.name, type: "sequence" })),
        ],
      },
    }),
    "file.newBin": (p) => {
      const bin = { id: nextId++, name: String(p.name), items: [] };
      bins.push(bin);
      return { bin: bin.id };
    },
    "file.import": (p) => {
      const bin = bins.find((b) => b.id === p.bin);
      const items = (p.paths as string[]).map((path) => {
        const item = nextId++;
        media.set(item, path);
        bin?.items.push(item);
        return item;
      });
      return { items, errors: [] };
    },
    "sequence.addTracks": (p) => {
      const s = seqOf(undefined);
      const made = { video: [] as number[], audio: [] as number[] };
      for (const kind of ["video", "audio"] as const)
        for (let i = 0; i < Number(p[kind] ?? 0); i++) {
          const t = track(`${kind === "video" ? "V" : "A"}${s[kind].length + 1}`);
          s[kind].push(t);
          made[kind].push(t.id);
        }
      return made;
    },
    "timeline.place": (p) => {
      const { t } = trackOf(p.track);
      if (t.locked) throw new Error("track is locked");
      if (!media.has(Number(p.item))) throw new Error("no item");
      const startFrame = Number(p.frame) + state.placeOffBy;
      const start = ticksOf(startFrame);
      const end = start + Number(p.duration);
      const clip: FakeClip = {
        clip: nextId++,
        item: Number(p.item),
        start,
        end,
        startFrame,
        endFrame: framesOf(end),
        sourceIn: Number(p.sourceIn ?? 0),
      };
      t.items.push(clip);
      return { clips: [clip.clip] };
    },
    "edit.clear": (p) => {
      const gone = p.clips as number[];
      for (const t of state.tracks(seqOf(undefined)))
        t.items = t.items.filter((c) => !gone.includes(c.clip));
      return {};
    },
    "sequence.deleteTrack": (p) => {
      const { s, t } = trackOf(p.track);
      s.video = s.video.filter((x) => x !== t);
      s.audio = s.audio.filter((x) => x !== t);
      return {};
    },
    "timeline.setTrack": (p) => {
      const { t } = trackOf(p.track);
      if (typeof p.enabled === "boolean") t.enabled = p.enabled;
      if (typeof p.locked === "boolean") t.locked = p.locked;
      return {};
    },
    "media.status": (p) => [{ item: p.item, path: media.get(Number(p.item)) ?? null }],
    "file.exportMedia": () => ({ done: true }),
    "file.exportFrame": () => ({ done: true }),
    "export.queue.cancel": () => ({}),
  };

  let down = false;
  const client: FilmCraftClient = {
    async call(method, params) {
      if (method !== "engine.execute") throw new Error(`unknown method ${method}`);
      const { command, params: p } = params as { command: string; params: Record<string, unknown> };
      return client.exec(command, p);
    },
    async exec<T>(command: string, params?: unknown) {
      const p = (params ?? {}) as Record<string, unknown>;
      log.push({ command, params: p });
      if (down) throw new Error(NOT_RUNNING);
      state.before(command, p);
      const run = commands[command];
      if (!run) throw new Error(`unknown command ${command}`);
      return run(p) as T;
    },
    close() {},
  };

  return {
    client,
    state,
    sequence: seq,
    ticksOf,
    /** FilmCraft quits: every later request finds nothing listening. */
    quit() {
      down = true;
    },
  };
}

export type FakeFilmCraft = ReturnType<typeof makeFakeFilmCraft>;
