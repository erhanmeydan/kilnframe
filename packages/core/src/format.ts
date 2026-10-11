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
 * Output size for a chosen format, derived from the sequence's short edge:
 * a 1080p sequence gives 1920x1080, 1080x1920 or 1080x1080.
 */
export function outputSize(sequence: Size, format: OutputFormat): Size {
  const short = Math.min(sequence.width, sequence.height);
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
