// Which frame of a scene the review shows. Text and shapes reveal on their words, at a pace the model chose,
// and some scenes leave with an exit animation: a fixed point catches text half written or half gone. So a
// few frames are taken between the usual still (the scene's last word plus its reveal, stillTimes) and just
// before the scene ends, and the fullest one is shown: the most drawn, before anything leaves.
import { spawnSync } from "node:child_process";
import { ffmpegPath } from "../config.js";

/** Frames per scene to choose from, the usual still included. */
const SAMPLES = 5;
/** Never in the last 0.2 s: the exit or the next scene. */
const END_GAP = 0.2;
/** A frame must be this much fuller than the usual still to replace it (noise, grain, ambient motion). */
const BETTER_BY = 0.03;

/** For each scene, the times to sample: the usual still first, then evenly up to just before the end. */
export function stillCandidates(
  scenes: { startS: number; endS: number }[],
  usual: number[],
): number[][] {
  return scenes.map((s, i) => {
    const from = usual[i] as number;
    const to = s.endS - END_GAP;
    if (to - from < 0.3) return [from];
    const step = (to - from) / (SAMPLES - 1);
    return Array.from({ length: SAMPLES }, (_, k) => from + step * k);
  });
}

/**
 * The index of the frame to show: the fullest, unless the usual still (the first) is within BETTER_BY of it,
 * so a scene that is already complete keeps the frame it always had.
 */
export function pickStill(times: number[], scores: number[], usual: number): number {
  let best = 0;
  scores.forEach((s, i) => {
    if (s > (scores[best] as number)) best = i;
  });
  const usualIndex = Math.max(0, times.indexOf(usual));
  const top = scores[best] as number;
  return (scores[usualIndex] as number) >= top * (1 - BETTER_BY) ? usualIndex : best;
}

/**
 * How much a frame shows: the density of edges (text, lines, shapes), measured small. A transparent overlay
 * still is laid on mid grey first, so what it draws counts and its empty parts do not.
 */
export function fullness(png: string): number {
  const r = spawnSync(
    ffmpegPath(),
    [
      "-v",
      "error",
      "-i",
      png,
      "-filter_complex",
      "color=c=gray:s=640x360[bg];[0:v]scale=640:360:flags=area[fg];[bg][fg]overlay=shortest=1,format=gray,edgedetect=low=0.08:high=0.2,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-",
      "-frames:v",
      "1",
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8" },
  );
  const m = /YAVG=([\d.]+)/.exec(r.stdout ?? "");
  return m ? Number(m[1]) : 0;
}
