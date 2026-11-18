// Captions mostly hold still: a line sits on screen for seconds and only changes when a word is said. A
// render that draws every frame spends most of its time on pictures identical to the one before. This
// works out which frames can differ from their predecessor, so only those are drawn and the rest repeat.
import type { Fps } from "../fps.js";

/** When a tween in the caption timeline moves something: [startS, endS]; a set has startS === endS. */
export interface TweenSpan {
  startS: number;
  endS: number;
}

/** GSAP's duration when a tween names none. */
const GSAP_DEFAULT_DURATION_S = 0.5;

/**
 * The spans of the timeline calls in a caption script (tl.set, tl.to, tl.from, tl.fromTo with a numeric
 * position), read by running the script against a recorder instead of GSAP. A call it cannot read
 * (another method, a position that is not a number) throws: guessing would drop changing frames.
 */
export function timelineSpans(script: string): TweenSpan[] {
  const spans: TweenSpan[] = [];
  const recorder: Record<string, (...args: unknown[]) => unknown> = {};
  for (const method of ["set", "to", "from", "fromTo"]) {
    recorder[method] = (...args: unknown[]) => {
      const position = args.at(-1);
      const vars = args.at(-2) as Record<string, unknown> | undefined;
      if (typeof position !== "number" || !Number.isFinite(position))
        throw new Error(`Caption timeline: tl.${method} without a numeric position.`);
      if (vars && ("repeat" in vars || "stagger" in vars || "delay" in vars || "yoyo" in vars))
        throw new Error(`Caption timeline: tl.${method} uses timing this reader does not follow.`);
      const duration =
        method === "set"
          ? 0
          : typeof vars?.duration === "number"
            ? vars.duration
            : GSAP_DEFAULT_DURATION_S;
      spans.push({ startS: position, endS: position + duration });
      return recorder;
    };
  }
  const proxy = new Proxy(recorder, {
    get(target, key) {
      if (typeof key === "string" && key in target) return target[key];
      throw new Error(`Caption timeline: tl.${String(key)} is not something this reader follows.`);
    },
  });
  new Function("tl", script)(proxy);
  return spans;
}

/** Frames HyperFrames renders for a composition of durationS: it rounds up. */
export function frameCount(durationS: number, fps: Fps): number {
  return Math.max(1, Math.ceil((durationS * fps.num) / fps.den - 1e-6));
}

/** Half a frame of slack on each side of a span, so a change between frame times is never missed. */
const SLACK_FRAMES = 0.5;

export interface FramePlan {
  /** The time in seconds of each frame that is drawn, in order. */
  times: number[];
  /** For every frame of the clip, the index in times of the picture it shows. */
  sourceOf: number[];
}

/**
 * Which of the clip's frames are drawn. Frame f is drawn when a span touches the stretch since frame f-1
 * (with slack), otherwise it shows the picture of the last drawn frame. The first frame is always drawn.
 */
export function framePlan(spans: TweenSpan[], durationS: number, fps: Fps): FramePlan {
  const n = frameCount(durationS, fps);
  const frame = (seconds: number) => (seconds * fps.num) / fps.den;
  // a frame is marked when a span covers any part of (f-1, f]: spread each span over the frames it touches
  const marked = new Uint8Array(n);
  marked[0] = 1;
  for (const s of spans) {
    const from = Math.max(1, Math.floor(frame(s.startS) - SLACK_FRAMES) + 1);
    const to = Math.min(n - 1, Math.ceil(frame(s.endS) + SLACK_FRAMES));
    for (let f = from; f <= to; f++) marked[f] = 1;
  }
  const times: number[] = [];
  const sourceOf: number[] = [];
  for (let f = 0; f < n; f++) {
    if (marked[f]) times.push((f * fps.den) / fps.num);
    sourceOf.push(times.length - 1);
  }
  return { times, sourceOf };
}

/**
 * Registers a timeline that plays only the drawn frames: at frame k it seeks the caption timeline to
 * times[k]. Its composition is times.length frames long (compressedDurationS).
 */
export function remapScript(times: number[], fps: Fps): string {
  const last = times.length - 1;
  const seconds = (last * fps.den) / fps.num;
  return `const __times = ${JSON.stringify(times.map((t) => Number(t.toFixed(6))))};
const __master = gsap.timeline({ paused: true });
const __at = { k: 0 };
__master.to(__at, { k: ${last}, duration: ${seconds.toFixed(6)}, ease: "none", onUpdate: () => tl.seek(__times[Math.round(__at.k)]) }, 0);
tl.seek(__times[0]);
window.__timelines["captions"] = __master;
`;
}

/** A duration HyperFrames turns into exactly frames frames (it rounds up: half a frame short of it). */
export function compressedDurationS(frames: number, fps: Fps): number {
  return ((frames - 0.5) * fps.den) / fps.num;
}
