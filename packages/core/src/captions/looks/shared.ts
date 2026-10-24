import type { OutputFormat } from "../../schemas/plan.js";
import type { CaptionColors, CaptionLine, CaptionWord } from "../types.js";

/** Font families the composition declares with @font-face for the look's files. */
export const CAPTION_FONT = "Caption";
export const CAPTION_FONT_ACTIVE = "CaptionActive";

export interface LookInput {
  colors: CaptionColors;
  width: number;
  height: number;
  format: OutputFormat;
}

/**
 * What a look adds to the caption composition. The composition owns the blocks (`#l<i>` holds a
 * `.block` with one `.row` per row of words), where they sit and when they are visible; the look
 * styles them and animates the block's entrance and the spoken words.
 */
export interface LookParts {
  css: string;
  wordMarkup: (w: CaptionWord, id: string) => string;
  /** GSAP calls on `tl` for line i, visible until `end` seconds. */
  animate: (line: CaptionLine, i: number, end: number) => string;
  /** Font size of the text in pixels; a block whose widest row would not fit is drawn smaller. */
  fontPx: number;
  letterSpacingEm: number;
  /** Extra space between words (CSS word-spacing on the block), in em. */
  wordSpacingEm: number;
  /** Space the block takes on each side of its widest row (padding, stroke). */
  padX: number;
}

/** Sizes are set for a 1080 px short edge and scale with the frame. */
export function scaleOf(o: LookInput): number {
  return Math.min(o.width, o.height) / 1080;
}

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );
}

/** Seconds for generated GSAP code. */
export function t(seconds: number): string {
  return Math.max(0, seconds).toFixed(3);
}
