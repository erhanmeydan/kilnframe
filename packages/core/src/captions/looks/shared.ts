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
  /** Advance width of text in em in the look's font at its weight (no letter spacing). */
  measureEm?: (text: string) => number;
}

/** When a line comes in and goes, in seconds of the composition it is drawn in. */
export interface LineTiming {
  /** Start of the line's first visible window; below 0 when it came in before this composition starts. */
  enterS: number;
  /** End of the line's last visible window. */
  endS: number;
}

/**
 * What a look adds to the caption composition. The composition owns the blocks (`#l<i>` holds a
 * `.block` with one `.row` per row of words), where they sit and when they are visible; the look
 * styles them and animates the block's entrance and the spoken words.
 */
export interface LookParts {
  css: string;
  wordMarkup: (w: CaptionWord, id: string) => string;
  /**
   * GSAP calls on `tl` for line i: its entrance at timing.enterS and its spoken words. rows holds the
   * line's words as they are drawn, row by row.
   */
  animate: (line: CaptionLine, i: number, timing: LineTiming, rows: CaptionWord[][]) => string;
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

/** The words still to animate: a word over before the composition starts stays as it is. */
export function liveWords(line: CaptionLine): { w: CaptionWord; n: number }[] {
  return line.words.map((w, n) => ({ w, n })).filter(({ w }) => w.end > 0);
}
