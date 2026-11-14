// Remove Pauses: where every clip of a sequence is cut and where its pieces land. Pure frame arithmetic shared by
// the hosts; every track is cut at the same frames, so video, linked audio and B-roll stay in sync by
// construction.
import type { TimelineCut } from "./host";

/** A cut on the sequence's frame grid, [startF, endF). */
export interface FrameCut {
  startF: number;
  endF: number;
}

/** A clip on the timeline, in sequence frames, [startF, endF). */
export interface PlanItem {
  key: string;
  track: number;
  kind: "video" | "audio";
  startF: number;
  endF: number;
}

/** What is left of an item: [fromF, toF) of the old sequence, placed at newStartF in the new one. */
export interface Piece {
  fromF: number;
  toF: number;
  newStartF: number;
}

// seconds times a rate like 30000/1001 lands a hair off a whole frame
const EPS = 1e-6;

/**
 * Cuts on the frame grid, clipped to [0, endF], under one frame dropped, sorted, merged. A cut starts on the
 * frame after the speech before it (never into a word's end); it ends on the frame nearest the speech after
 * it, which already starts at its first sound: rounded down, each piece began with up to a frame of room,
 * a gap the editor saw before almost every clip.
 */
export function frameCuts(cuts: TimelineCut[], fps: number, endF: number): FrameCut[] {
  const snapped = cuts
    .map((c) => ({
      startF: Math.max(0, Math.ceil(c.startS * fps - EPS)),
      endF: Math.min(endF, Math.floor(c.endS * fps + 0.5 + EPS)),
    }))
    .filter((c) => c.endF - c.startF >= 1)
    .sort((a, b) => a.startF - b.startF);
  const out: FrameCut[] = [];
  for (const c of snapped) {
    const last = out[out.length - 1];
    if (last && c.startF <= last.endF) last.endF = Math.max(last.endF, c.endF);
    else out.push({ ...c });
  }
  return out;
}

/** Frames removed before `frame`. */
export function shiftAt(cuts: FrameCut[], frame: number): number {
  let shift = 0;
  for (const c of cuts) {
    if (c.startF >= frame) break;
    shift += Math.min(c.endF, frame) - c.startF;
  }
  return shift;
}

/** What is left of an item, in order; empty when it lies wholly inside cuts. */
export function piecesOf(item: PlanItem, cuts: FrameCut[]): Piece[] {
  const pieces: Piece[] = [];
  let from = item.startF;
  for (const c of cuts) {
    if (c.endF <= from) continue;
    if (c.startF >= item.endF) break;
    if (c.startF > from) pieces.push({ fromF: from, toF: c.startF, newStartF: 0 });
    from = Math.max(from, c.endF);
  }
  if (from < item.endF) pieces.push({ fromF: from, toF: item.endF, newStartF: 0 });
  for (const p of pieces) p.newStartF = p.fromF - shiftAt(cuts, p.fromF);
  return pieces;
}

export function newEndF(endF: number, cuts: FrameCut[]): number {
  return endF - shiftAt(cuts, endF);
}

/** The shortest piece of an item (Premiere's seed length); 0 when nothing is left. */
export function seedLength(pieces: Piece[]): number {
  return pieces.length ? Math.min(...pieces.map((p) => p.toF - p.fromF)) : 0;
}
