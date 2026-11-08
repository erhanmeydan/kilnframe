import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import * as fontkit from "fontkit";
import { formatOf } from "../format.js";
import { framesToSeconds, parseFps } from "../fps.js";
import { vendorDir } from "../project/assemble.js";
import { PORTRAIT_CENTRE, safeArea } from "../safe-area.js";
import { look as bant } from "./looks/bant.js";
import { look as daktilo } from "./looks/daktilo.js";
import { look as dinamik } from "./looks/dinamik.js";
import { look as editoryal } from "./looks/editoryal.js";
import { look as hap } from "./looks/hap.js";
import { look as karaoke } from "./looks/karaoke.js";
import { look as kilLacivert } from "./looks/kil-lacivert.js";
import { look as loud } from "./looks/loud.js";
import { look as sakin } from "./looks/sakin.js";
import {
  CAPTION_FONT,
  CAPTION_FONT_ACTIVE,
  EMPHASIS_SCALE,
  escapeHtml,
  t,
  type LookInput,
  type LookParts,
} from "./looks/shared.js";
import { CAPTION_LOOKS, type CaptionLook } from "./styles.js";
import type { CaptionColors, CaptionLine, CaptionStyleId, CaptionWord } from "./types.js";
import { lowerCase, upperCase } from "./upper.js";

export interface CaptionDoc {
  lines: CaptionLine[];
  /** Language of the speech (Whisper's code); uppercase and lowercase looks follow its rules. */
  language: string;
  /** Names that keep their own spelling in uppercase and lowercase looks. */
  glossary: string[];
  durationS: number;
  width: number;
  height: number;
  fps: string;
  /** Stretches of the timeline where no caption is shown (an animation insert sits there). */
  hideSpans: { startS: number; endS: number }[];
  /**
   * How an emphasised word is drawn; missing: "color". Where the accent cannot show (it is the text colour,
   * or the spoken word sits on an accent fill) colour is drawn as scale.
   */
  emphasis?: "color" | "scale" | "both";
}

export interface TimeSpan {
  startS: number;
  endS: number;
}

/** How long a line stays after its last word when the next line has not started yet. */
export const CAPTION_HOLD_S = 0.35;

export { PORTRAIT_CENTRE };

const LOOK_MODULES: Record<CaptionStyleId, (o: LookInput) => LookParts> = {
  "kil-lacivert": kilLacivert,
  loud,
  dinamik,
  hap,
  karaoke,
  daktilo,
  sakin,
  bant,
  editoryal,
};

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

/** The text's font file: a font of the user's own when given (an absolute path), else the look's own under vendor/fonts. */
function fontFile(look: CaptionLook, font?: string): string {
  return font ?? join(vendorDir(), "fonts", look.font);
}

/** The CSS format() hint for a font file, by its kind. */
const FONT_FORMATS: Record<string, string> = {
  ".ttf": "truetype",
  ".otf": "opentype",
  ".woff2": "woff2",
};

/** The name the font is copied under beside index.html, and the format() hint the page gives for it. */
function fontCopy(file: string): { name: string; format: string } {
  const ext = extname(file).toLowerCase();
  return {
    name: `font${FONT_FORMATS[ext] ? ext : ".ttf"}`,
    format: FONT_FORMATS[ext] ?? "truetype",
  };
}

/** A word's own colour is used only in this form; anything else could break out of the style rule. */
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
/** Room each side of a scaled word beyond its own growth. */
const EMPHASIS_MARGIN_EM = 0.08;
/** The longest emoji value drawn (as the project's limit); a longer one, or one with control characters, is left out. */
const EMOJI_MAX = 16;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** The system's colour emoji fonts, as the Graphics panel's. */
const EMOJI_FONTS = `"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji"`;

function seconds(s: number): string {
  return s.toFixed(6).replace(/\.?0+$/, "") || "0";
}

/**
 * The caption composition: one block per line on a transparent page, one paused GSAP timeline. Given a
 * segment (captionSegments) it holds only that segment's lines, timed from the segment's start. Given a font
 * file of the user's own, every word is set in it, the active word too, in place of the look's fonts.
 */
export function captionHtml(
  doc: CaptionDoc,
  lookId: CaptionStyleId,
  colors: CaptionColors,
  segment: CaptionSegment = captionSegments(doc, Infinity)[0] as CaptionSegment,
  ownFont?: string,
): string {
  const style = CAPTION_LOOKS[lookId];
  const { width, height } = doc;
  const format = formatOf({ width, height });
  const font = openFont(fontFile(style, ownFont), style.weight);
  const measureEm = (text: string) =>
    font.layout(text).positions.reduce((sum, p) => sum + p.xAdvance, 0) / font.unitsPerEm;
  const parts = LOOK_MODULES[lookId]({ colors, width, height, format, measureEm });
  const safe = safeArea(format, width, height);
  const maxRowPx = width - safe.left - safe.right - 2 * parts.padX;
  const maxChars = style.maxChars[format];
  const mode = doc.emphasis ?? "color";
  // the accent cannot show on an emphasised word: colour falls back to scale
  const noColour =
    colors.accent.toLowerCase() === colors.text.toLowerCase() || parts.accentFill === true;
  const emphasisColour = mode !== "scale" && !noColour;
  const emphasisScale = mode !== "color" || noColour;

  const blocks: string[] = [];
  // rules for the new fields only, so a doc without them writes the same page as before
  const extraCss: string[] = [];
  let anyEmoji = false;
  let script = "";
  for (const entry of segment.entries) {
    const i = entry.index;
    const line = {
      ...entry.line,
      words: entry.line.words.map((w) => {
        const word: CaptionWord = {
          ...w,
          text: style.uppercase
            ? upperCase(w.text, doc.language, doc.glossary)
            : style.lowercase
              ? lowerCase(w.text, doc.language, doc.glossary)
              : w.text,
        };
        // the colour the word is drawn in, handed to the look so a timeline that colours it can give it back
        const color = w.emphasis === true && emphasisColour ? colors.accent : w.color;
        delete word.color;
        if (color && HEX_COLOR.test(color)) word.color = color;
        return word;
      }),
    };
    // an emoji past the project's limit or with control characters (a hand-edited file) is left out
    if (line.emoji !== undefined && (line.emoji.length > EMOJI_MAX || CONTROL.test(line.emoji)))
      delete line.emoji;
    const ids = new Map(line.words.map((w, n) => [w, `w${i}_${n}`]));
    // a scaled word's margins hold its growth (CSS scale takes no layout room) and a little more, so its
    // neighbours move aside; in em of the word, each side
    const room = new Map(
      line.words
        .filter((w) => w.emphasis === true && emphasisScale)
        .map((w) => [
          w,
          Number(
            (
              ((EMPHASIS_SCALE - 1) / 2) * rowWidthEm(font, w.text, parts) +
              EMPHASIS_MARGIN_EM
            ).toFixed(3),
          ),
        ]),
    );
    for (const w of line.words) {
      const id = ids.get(w) as string;
      const margin = room.get(w);
      if (w.color) extraCss.push(`#${id}{color:${w.color}}`);
      // a look whose said word is drawn by a fill of its own draws that fill in the word's colour too
      if (w.color && parts.fillSelector)
        extraCss.push(`#${id} ${parts.fillSelector}{color:${w.color}}`);
      if (margin !== undefined)
        extraCss.push(`#${id}{display:inline-block;scale:${EMPHASIS_SCALE};margin:0 ${margin}em}`);
    }
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
    // a scaled word's margins widen its row
    const growthEm = (ws: typeof line.words) =>
      ws.reduce((sum, w) => sum + 2 * (room.get(w) ?? 0), 0);
    const widest = Math.max(
      ...rows.map(
        (r, ri) =>
          (rowWidthEm(font, r.join(" "), parts) + growthEm(rowWords[ri] as typeof line.words)) *
          parts.fontPx,
      ),
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
    const emoji = line.emoji
      ? `<div class="emoji" style="font-size:${Math.round(size * 11) / 10}px">${escapeHtml(line.emoji)}</div>`
      : "";
    if (emoji) anyEmoji = true;
    blocks.push(
      emoji
        ? // the emoji hangs above the block in a box as large as the block, so the line sits where it would without it
          `<div class="line has-emoji" id="l${i}"><div class="emoji-box">${emoji}<div class="block" style="font-size:${size}px">${markup}</div></div></div>`
        : `<div class="line" id="l${i}"><div class="block" style="font-size:${size}px">${markup}</div></div>`,
    );
    for (const w of entry.windows)
      script += `tl.set("#l${i}",{opacity:1},${w.startS.toFixed(3)});tl.set("#l${i}",{opacity:0},${w.endS.toFixed(3)});\n`;
    script += parts.animate(line, i, entry.timing, rowWords, room);
    // the emoji pops in with the line; one that came in before this composition starts is already on screen
    if (emoji && entry.timing.enterS >= 0)
      // it rises with a block that slides in
      script += parts.enterYPx
        ? `tl.fromTo("#l${i} .emoji",{opacity:0,scale:0.6,y:${parts.enterYPx}},{opacity:1,scale:1,y:0,duration:0.18,ease:"back.out(2)"},${t(entry.timing.enterS)});\n`
        : `tl.fromTo("#l${i} .emoji",{opacity:0,scale:0.6},{opacity:1,scale:1,duration:0.18,ease:"back.out(2)"},${t(entry.timing.enterS)});\n`;
  }
  if (anyEmoji)
    extraCss.push(
      `.emoji-box{position:relative}`,
      // centred over the block by flex, which overflows both sides alike when the emoji is wider than the block
      `.emoji{position:absolute;left:0;right:0;bottom:100%;display:flex;justify-content:center;white-space:nowrap;font-family:${EMOJI_FONTS};line-height:1;margin-bottom:.15em}`,
    );

  const placement =
    format === "portrait"
      ? `top:${Math.round(height * PORTRAIT_CENTRE)}px;align-items:center`
      : `bottom:${safe.bottom}px;align-items:flex-end`;
  const copy = fontCopy(fontFile(style, ownFont));
  // a look that names its active word's family gets the user's font there too
  const activeSrc = ownFont
    ? `url("${copy.name}") format("${copy.format}")`
    : style.fontActive
      ? `url("font-active.ttf") format("truetype")`
      : "";
  const active = activeSrc
    ? `\n@font-face{font-family:"${CAPTION_FONT_ACTIVE}";src:${activeSrc};font-weight:${style.weightActive ?? style.weight}}`
    : "";
  const duration = seconds(segment.endS - segment.startS);
  return `<!doctype html>
<html lang="${doc.language}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=${width}, height=${height}">
<script src="gsap.min.js"></script>
<style>
@font-face{font-family:"${CAPTION_FONT}";src:url("${copy.name}") format("${copy.format}");font-weight:${style.weight}}${active}
html,body{margin:0;background:transparent}
#root{position:relative;width:${width}px;height:${height}px;overflow:hidden;background:transparent}
#captions{position:absolute;inset:0}
.line{position:absolute;left:0;right:0;${placement};height:0;display:flex;justify-content:center;opacity:0}
.block{text-align:center}
.row{white-space:nowrap}
${parts.css}
</style>${extraCss.length ? `\n<style>\n${extraCss.join("\n")}\n</style>` : ""}
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

/**
 * Writes a renderable caption project into dir: index.html with the font and GSAP beside it. The font is the
 * look's own, or a font file of the user's own (an absolute path) for every word.
 */
export function buildCaptionProject(
  doc: CaptionDoc,
  look: CaptionStyleId,
  colors: CaptionColors,
  dir: string,
  segment?: CaptionSegment,
  font?: string,
): void {
  const style = CAPTION_LOOKS[look];
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), captionHtml(doc, look, colors, segment, font));
  copyFileSync(join(vendorDir(), "gsap", "gsap.min.js"), join(dir, "gsap.min.js"));
  const file = fontFile(style, font);
  copyFileSync(file, join(dir, fontCopy(file).name));
  if (style.fontActive && !font)
    copyFileSync(join(vendorDir(), "fonts", style.fontActive), join(dir, "font-active.ttf"));
}
