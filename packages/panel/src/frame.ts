// The frame of a new story sequence (packages/core/src/format.ts follows the same rule for inserts), and how
// a clip rendered at most 4K is scaled up to a larger sequence.
import { MAX_SHORT_EDGE } from "../../core/src/format";

/** A 16:9, 9:16 or 1:1 frame on the short side of width x height, even sizes (core format.ts does the same). */
export function frameFor(
  format: "landscape" | "portrait" | "square",
  width: number,
  height: number,
): { width: number; height: number } {
  const short = Math.min(width, height);
  const long = Math.round((short * 16) / 9 / 2) * 2;
  if (format === "landscape") return { width: long, height: short };
  if (format === "portrait") return { width: short, height: long };
  return { width: short, height: short };
}

/**
 * How much a Kilnframe clip is scaled up to fill a sequence (1 up to 4K): a 6K or 8K sequence gets an insert
 * or caption clip rendered at 4K, so it is placed at, say, 200% on an 8K timeline.
 */
export function insertScale(width: number, height: number): number {
  return Math.max(1, Math.min(width, height) / MAX_SHORT_EDGE);
}

/** A sequence's frame brought down to MAX_SHORT_EDGE, keeping its shape (caption clips), even sizes. */
export function renderFrame(width: number, height: number): { width: number; height: number } {
  const s = insertScale(width, height);
  const even = (n: number) => Math.round(n / s / 2) * 2;
  return s === 1 ? { width, height } : { width: even(width), height: even(height) };
}
