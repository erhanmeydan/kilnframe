// A multi-line box grows with its text, so a long note or description stays readable without scrolling
// inside it. Premiere's UXP has no resize grip (CSS resize does nothing there), so this is the only way
// to make a box taller. One-line boxes (.one) keep their height.

/** Never taller than this, unless the box starts taller: then up to twice its own height. */
export const GROW_MAX_PX = 320;

/** The height a box takes: its text's height, at least where it started, at most the cap. */
export function grownHeight(basePx: number, contentPx: number): number {
  const max = Math.max(GROW_MAX_PX, basePx * 2);
  return Math.round(Math.min(max, Math.max(basePx, contentPx)));
}

/** Average width of a character in em, and the line height in px, of the panel's 12 px field text. */
const CHAR_EM = 0.56;
const FONT_PX = 12;
const LINE_PX = 15;
/** The native field's own padding: sideways (both sides together) and up and down. */
const SIDE_PX = 12;
const ENDS_PX = 8;

/**
 * The text's height from its characters and the box's width. Premiere's UXP reports no scrollHeight
 * for a textarea and lays out no measuring element either (both read 0); measured there, this matched
 * the drawn lines.
 */
export function estimatedHeight(text: string, widthPx: number): number {
  const perLine = Math.max(8, Math.floor((widthPx - SIDE_PX) / (CHAR_EM * FONT_PX)));
  const lines = text
    .split("\n")
    .reduce((sum, para) => sum + Math.max(1, Math.ceil(para.length / perLine)), 0);
  return lines * LINE_PX + ENDS_PX;
}

function isGrowing(el: Element | null): el is HTMLTextAreaElement {
  return el?.tagName === "TEXTAREA" && !el.classList.contains("one");
}

/** The box's drawn height: offsetHeight, or the layout box where a host reports none. */
function boxHeight(el: HTMLTextAreaElement): number {
  return el.offsetHeight || el.getBoundingClientRect?.().height || 0;
}

/** Fits one box to its text. Its starting height (from the CSS) is kept as its smallest. */
export function grow(el: Element | null): void {
  if (!isGrowing(el)) return;
  let base = Number(el.getAttribute("data-base-height"));
  if (!base) {
    base = boxHeight(el);
    // not laid out yet (a hidden tab): nothing to measure
    if (!base) return;
    el.setAttribute("data-base-height", String(base));
  }
  // back to the starting height first, so scrollHeight measures the text and not the box
  el.style.height = `${base}px`;
  const text = el.value ?? "";
  const measured = el.scrollHeight || 0;
  const frame = Math.max(0, boxHeight(el) - (el.clientHeight || boxHeight(el)));
  const content = measured
    ? measured + frame
    : text
      ? estimatedHeight(text, el.clientWidth || el.getBoundingClientRect?.().width || 0)
      : 0;
  const height = grownHeight(base, content);
  // a capped box keeps its scroll bar for the rest
  if (height !== base) el.style.height = `${height}px`;
}

/** Fits every multi-line box under root (after a render has set their values). */
export function growAll(root: ParentNode): void {
  root.querySelectorAll("textarea").forEach((el) => grow(el));
}
