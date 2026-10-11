// The frame of a new story sequence (packages/core/src/format.ts follows the same rule for inserts).

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
