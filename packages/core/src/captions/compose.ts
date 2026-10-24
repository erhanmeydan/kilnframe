import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as fontkit from "fontkit";
import { formatOf } from "../format.js";
import { framesToSeconds, parseFps } from "../fps.js";
import { vendorDir } from "../project/assemble.js";
import { PORTRAIT_CENTRE, safeArea } from "../safe-area.js";
import { look as bant } from "./looks/bant.js";
import { look as kilLacivert } from "./looks/kil-lacivert.js";
import { look as loud } from "./looks/loud.js";
import {
  CAPTION_FONT,
  CAPTION_FONT_ACTIVE,
  type LookInput,
  type LookParts,
} from "./looks/shared.js";
import { CAPTION_LOOKS, type CaptionLook } from "./styles.js";
import type { CaptionColors, CaptionLine, CaptionStyleId } from "./types.js";
import { upperCase } from "./upper.js";

export interface CaptionDoc {
  lines: CaptionLine[];
  /** Language of the speech (Whisper's code); uppercase looks follow its rules. */
  language: string;
  /** Names that keep their own spelling in uppercase looks. */
  glossary: string[];
  durationS: number;
  width: number;
  height: number;
  fps: string;
  /** Stretches of the timeline where no caption is shown (an animation insert sits there). */
  hideSpans: { startS: number; endS: number }[];
}

export interface TimeSpan {
  startS: number;
  endS: number;
}

/** How long a line stays after its last word when the next line has not started yet. */
export const CAPTION_HOLD_S = 0.35;

export { PORTRAIT_CENTRE };

const LOOK_MODULES: Partial<Record<CaptionStyleId, (o: LookInput) => LookParts>> = {
  "kil-lacivert": kilLacivert,
  loud,
  bant,
};

function lookParts(id: CaptionStyleId, o: LookInput): LookParts {
  const make = LOOK_MODULES[id];
  if (!make) throw new Error(`The caption look "${id}" is not available yet.`);
  return make(o);
}

/** Lines that have something to show: an emptied or wordless line is left out of the render and the SRT. */
export function captionLines(lines: CaptionLine[]): CaptionLine[] {
  return lines.filter((l) => l.text.trim() !== "" && l.words.some((w) => w.text.trim() !== ""));
}

function cut(span: TimeSpan, hide: TimeSpan): TimeSpan[] {
  if (hide.endS <= span.startS || hide.startS >= span.endS) return [span];
  const parts: TimeSpan[] = [];
  if (hide.startS > span.startS) parts.push({ startS: span.startS, endS: hide.startS });
  if (hide.endS < span.endS) parts.push({ startS: hide.endS, endS: span.endS });
  return parts;
}

/**
 * When each line is on screen: from its first word until the next line starts, at most CAPTION_HOLD_S
 * after its last word, minus the hidden spans (a line crossing one shows before and after it).
 */
export function captionWindows(
  lines: CaptionLine[],
  durationS: number,
  hideSpans: TimeSpan[],
): TimeSpan[][] {
  return lines.map((line, i) => {
    const next = lines[i + 1];
    const end = Math.min(next ? next.start : durationS, line.end + CAPTION_HOLD_S, durationS);
    let parts: TimeSpan[] = [{ startS: Math.max(0, line.start), endS: end }];
    for (const hide of hideSpans) parts = parts.flatMap((p) => cut(p, hide));
    return parts.filter((p) => p.endS - p.startS > 0.001);
  });
}

/** Long captions render in pieces of about this length, joined into one clip afterwards. */
export const CAPTION_SEGMENT_S = 480;

export interface SegmentEntry {
  /** The line's number among the doc's visible lines (its block id). */
  index: number;
  /** The line with its times relative to the segment start. */
  line: CaptionLine;
  /** Where the line shows inside the segment, relative to its start. */
  windows: TimeSpan[];
  /** Entrance and exit relative to the segment start (outside it when the line crosses an edge). */
  timing: { enterS: number; endS: number };
}

export interface CaptionSegment {
  startS: number;
  endS: number;
  entries: SegmentEntry[];
}

/**
 * Cuts the doc into segments on frame edges, each holding the lines that show inside it with their
 * windows clipped to its edges. A doc no longer than segmentS is one segment.
 */
export function captionSegments(doc: CaptionDoc, segmentS = CAPTION_SEGMENT_S): CaptionSegment[] {
  const lines = captionLines(doc.lines);
  const windows = captionWindows(lines, doc.durationS, doc.hideSpans);
  const fps = parseFps(doc.fps);
  const edges = [0];
  if (doc.durationS > segmentS) {
    const frames = Math.max(1, Math.round((segmentS * fps.num) / fps.den));
    for (let k = 1; ; k++) {
      const at = framesToSeconds(k * frames, fps);
      if (at >= doc.durationS - 1e-6) break;
      edges.push(at);
    }
  }
  edges.push(doc.durationS);
  const shift = (v: number, by: number) => v - by;
  return edges.slice(0, -1).map((startS, k) => {
    const endS = edges[k + 1] as number;
    const entries: SegmentEntry[] = [];
    lines.forEach((line, index) => {
      const shown = windows[index] as TimeSpan[];
      const inside = shown
        .map((w) => ({ startS: Math.max(w.startS, startS), endS: Math.min(w.endS, endS) }))
        .filter((w) => w.endS - w.startS > 1e-6)
        .map((w) => ({ startS: shift(w.startS, startS), endS: shift(w.endS, startS) }));
      if (!inside.length) return;
      entries.push({
        index,
        line: {
          ...line,
          start: shift(line.start, startS),
          end: shift(line.end, startS),
          words: line.words.map((w) => ({
            ...w,
            start: shift(w.start, startS),
            end: shift(w.end, startS),
          })),
        },
        windows: inside,
        timing: {
          enterS: shift((shown[0] as TimeSpan).startS, startS),
          endS: shift((shown[shown.length - 1] as TimeSpan).endS, startS),
        },
      });
    });
    return { startS, endS, entries };
  });
}

const rowLength = (words: string[]) => words.join(" ").length;

/**
 * Splits a block's words into rows: one row when it fits, otherwise the break that gives the most even
 * rows of at most maxChars (the lower row the longer one on a tie). Two rows at most; a block that does
 * not fit is drawn smaller instead.
 */
export function blockRows(words: string[], maxChars: number, maxLines: 1 | 2): string[][] {
  if (maxLines === 1 || words.length < 2 || rowLength(words) <= maxChars) return [words];
  let best: { k: number; score: number } | null = null;
  for (let k = 1; k < words.length; k++) {
    const top = rowLength(words.slice(0, k));
    const bottom = rowLength(words.slice(k));
    const over = Math.max(0, top - maxChars) + Math.max(0, bottom - maxChars);
    // overflow first, then the longer row, then a slightly longer lower row
    const score = over * 1e6 + Math.max(top, bottom) * 1e3 + (top > bottom ? 1 : 0);
    if (!best || score < best.score) best = { k, score };
  }
  const k = (best as { k: number }).k;
  return [words.slice(0, k), words.slice(k)];
}

type Font = fontkit.Font;
const fonts = new Map<string, Font>();

function openFont(file: string, weight: number): Font {
  const key = `${file}@${weight}`;
  let font = fonts.get(key);
  if (!font) {
    const opened = fontkit.openSync(file) as Font;
    font = "wght" in (opened.variationAxes ?? {}) ? opened.getVariation({ wght: weight }) : opened;
    fonts.set(key, font);
  }
  return font;
}

/** Width of a row of text in em, as the browser lays it out with the look's letter spacing. */
function rowWidthEm(font: Font, text: string, parts: LookParts): number {
  const run = font.layout(text);
  const advance = run.positions.reduce((sum, p) => sum + p.xAdvance, 0) / font.unitsPerEm;
  const spaces = text.split(" ").length - 1;
  return advance + parts.letterSpacingEm * [...text].length + parts.wordSpacingEm * spaces;
}

function fontFile(look: CaptionLook): string {
  return join(vendorDir(), "fonts", look.font);
}

function seconds(s: number): string {
  return s.toFixed(6).replace(/\.?0+$/, "") || "0";
}

/**
 * The caption composition: one block per line on a transparent page, one paused GSAP timeline. Given a
 * segment (captionSegments) it holds only that segment's lines, timed from the segment's start.
 */
export function captionHtml(
  doc: CaptionDoc,
  lookId: CaptionStyleId,
  colors: CaptionColors,
  segment: CaptionSegment = captionSegments(doc, Infinity)[0] as CaptionSegment,
): string {
  const style = CAPTION_LOOKS[lookId];
  const { width, height } = doc;
  const format = formatOf({ width, height });
  const font = openFont(fontFile(style), style.weight);
  const measureEm = (text: string) =>
    font.layout(text).positions.reduce((sum, p) => sum + p.xAdvance, 0) / font.unitsPerEm;
  const parts = lookParts(lookId, { colors, width, height, format, measureEm });
  const safe = safeArea(format, width, height);
  const maxRowPx = width - safe.left - safe.right - 2 * parts.padX;
  const maxChars = style.maxChars[format];

  const blocks: string[] = [];
  let script = "";
  for (const entry of segment.entries) {
    const i = entry.index;
    const line = {
      ...entry.line,
      words: entry.line.words.map((w) => ({
        ...w,
        text: style.uppercase ? upperCase(w.text, doc.language, doc.glossary) : w.text,
      })),
    };
    const ids = new Map(line.words.map((w, n) => [w, `w${i}_${n}`]));
    const rows = blockRows(
      line.words.map((w) => w.text),
      maxChars,
      style.maxLines,
    );
    let at = 0;
    const rowWords = rows.map((r) => {
      const slice = line.words.slice(at, at + r.length);
      at += r.length;
      return slice;
    });
    const widest = Math.max(
      ...rows.map((r) => rowWidthEm(font, r.join(" "), parts) * parts.fontPx),
    );
    // a row that would leave the safe area (a long word or an edited line) draws the whole block smaller
    const scale = Math.min(1, maxRowPx / widest);
    const size = Math.floor(parts.fontPx * scale * 10) / 10;
    const markup = rowWords
      .map(
        (ws) =>
          `<div class="row">${ws.map((w) => parts.wordMarkup(w, ids.get(w) as string)).join(" ")}</div>`,
      )
      .join("");
    blocks.push(
      `<div class="line" id="l${i}"><div class="block" style="font-size:${size}px">${markup}</div></div>`,
    );
    for (const w of entry.windows)
      script += `tl.set("#l${i}",{opacity:1},${w.startS.toFixed(3)});tl.set("#l${i}",{opacity:0},${w.endS.toFixed(3)});\n`;
    script += parts.animate(line, i, entry.timing);
  }

  const placement =
    format === "portrait"
      ? `top:${Math.round(height * PORTRAIT_CENTRE)}px;align-items:center`
      : `bottom:${safe.bottom}px;align-items:flex-end`;
  const active = style.fontActive
    ? `\n@font-face{font-family:"${CAPTION_FONT_ACTIVE}";src:url("font-active.ttf") format("truetype");font-weight:${style.weightActive ?? style.weight}}`
    : "";
  const duration = seconds(segment.endS - segment.startS);
  return `<!doctype html>
<html lang="${doc.language}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=${width}, height=${height}">
<script src="gsap.min.js"></script>
<style>
@font-face{font-family:"${CAPTION_FONT}";src:url("font.ttf") format("truetype");font-weight:${style.weight}}${active}
html,body{margin:0;background:transparent}
#root{position:relative;width:${width}px;height:${height}px;overflow:hidden;background:transparent}
#captions{position:absolute;inset:0}
.line{position:absolute;left:0;right:0;${placement};height:0;display:flex;justify-content:center;opacity:0}
.block{text-align:center}
.row{white-space:nowrap}
${parts.css}
</style>
</head>
<body>
<div id="root" data-composition-id="captions" data-start="0" data-width="${width}" data-height="${height}" data-duration="${duration}">
<div id="captions" class="clip" data-start="0" data-duration="${duration}" data-track-index="0">
${blocks.join("\n")}
</div>
</div>
<script>
const tl = gsap.timeline({ paused: true });
${script}window.__timelines["captions"] = tl;
</script>
</body>
</html>
`;
}

/** Writes a renderable caption project into dir: index.html with the look's font and GSAP beside it. */
export function buildCaptionProject(
  doc: CaptionDoc,
  look: CaptionStyleId,
  colors: CaptionColors,
  dir: string,
  segment?: CaptionSegment,
): void {
  const style = CAPTION_LOOKS[look];
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), captionHtml(doc, look, colors, segment));
  copyFileSync(join(vendorDir(), "gsap", "gsap.min.js"), join(dir, "gsap.min.js"));
  copyFileSync(fontFile(style), join(dir, "font.ttf"));
  if (style.fontActive)
    copyFileSync(join(vendorDir(), "fonts", style.fontActive), join(dir, "font-active.ttf"));
}
