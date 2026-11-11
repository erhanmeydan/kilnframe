import type { OutputFormat } from "./schemas/plan.js";

export interface Size {
  width: number;
  height: number;
}

/** Parses "1920x1080" into a size. */
export function parseSize(input: string): Size {
  const match = /^(\d+)x(\d+)$/.exec(input.trim());
  if (!match) throw new Error(`Invalid size: "${input}". Expected e.g. "1920x1080".`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width <= 0 || height <= 0)
    throw new Error(`Invalid size: "${input}". Values must be positive.`);
  return { width, height };
}

export function formatSize(size: Size): string {
  return `${size.width}x${size.height}`;
}

/** The format a sequence already has: wider is landscape, taller is portrait, equal is square. */
export function formatOf(size: Size): OutputFormat {
  if (size.width === size.height) return "square";
  return size.width > size.height ? "landscape" : "portrait";
}

const even = (n: number) => Math.round(n / 2) * 2;

/**
 * The largest short edge an insert is rendered at: 4K. A 6K or 8K sequence gets a 4K insert that the editor
 * scales up to fill the frame (the panel's hosts, frame.ts insertScale): render time and file size grow with
 * the pixels, 8K has four times 4K's, and code-drawn graphics scaled up from 4K hold up on such a timeline.
 */
export const MAX_SHORT_EDGE = 2160;

/**
 * Output size for a chosen format, derived from the sequence's short edge (at most MAX_SHORT_EDGE):
 * a 1080p sequence gives 1920x1080, 1080x1920 or 1080x1080, an 8K one 3840x2160, 2160x3840 or 2160x2160.
 */
export function outputSize(sequence: Size, format: OutputFormat): Size {
  const short = Math.min(sequence.width, sequence.height, MAX_SHORT_EDGE);
  const long = even((short * 16) / 9);
  switch (format) {
    case "landscape":
      return { width: long, height: short };
    case "portrait":
      return { width: short, height: long };
    case "square":
      return { width: short, height: short };
  }
}
