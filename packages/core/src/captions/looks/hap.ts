import { CAPTION_LOOKS } from "../styles.js";
import {
  CAPTION_FONT,
  escapeHtml,
  liveWords,
  scaleOf,
  t,
  type LookInput,
  type LookParts,
} from "./shared.js";

/** The chip reaches this far past each side of its word, in em. */
const CHIP_PAD_EM = 0.2;
/** Space added between words so a neighbour keeps a clear gap to the chip's edge. */
const WORD_SPACING_EM = 0.14;
const LETTER_SPACING_EM = -0.01;
/** How long the chip takes to move to the next word. */
const MOVE_S = 0.12;

const em = (v: number) => `"${v.toFixed(3)}em"`;

/** White words; the spoken word sits on a rounded chip in the accent colour that moves word to word. */
export function look(o: LookInput): LookParts {
  const k = scaleOf(o);
  const px = (v: number) => `${Math.round(v * k)}px`;
  const { text, accent } = o.colors;
  const fontPx = Math.round((o.format === "landscape" ? 64 : 70) * k);
  const measure = o.measureEm ?? ((s: string) => 0.55 * s.length);
  // advance of a word as the browser draws it: letter spacing follows every character
  const width = (s: string) => measure(s) + LETTER_SPACING_EM * [...s].length;
  const space = width(" ") + WORD_SPACING_EM;
  const css = `.block{position:relative;z-index:0;font-family:${CAPTION_FONT};font-weight:${CAPTION_LOOKS.hap.weight};line-height:1.24;letter-spacing:${LETTER_SPACING_EM}em;word-spacing:${WORD_SPACING_EM}em;color:${text};text-shadow:0 ${px(3)} ${px(14)} rgba(0,0,0,.55),0 ${px(1)} ${px(3)} rgba(0,0,0,.45)}
.w{display:inline-block;position:relative}
.c{position:absolute;z-index:-1;left:${-CHIP_PAD_EM}em;width:calc(100% + ${2 * CHIP_PAD_EM}em);top:.05em;bottom:.07em;border-radius:.3em;background:${accent};box-shadow:0 ${px(6)} ${px(16)} rgba(0,0,0,.28);opacity:0}`;
  return {
    css,
    fontPx,
    letterSpacingEm: LETTER_SPACING_EM,
    wordSpacingEm: WORD_SPACING_EM,
    // the chip reaches past an edge word
    padX: Math.ceil(fontPx * CHIP_PAD_EM),
    wordMarkup: (w, id) =>
      `<span class="w" id="${id}"><i class="c"></i>${escapeHtml(w.text)}</span>`,
    animate: (line, i, timing, rows) => {
      // a line that came in before this composition starts is already on screen
      let a =
        timing.enterS >= 0
          ? `tl.fromTo("#l${i} .block",{opacity:0,y:${Math.round(10 * k)}},{opacity:1,y:0,duration:0.18,ease:"power2.out"},${t(timing.enterS)});\n`
          : "";
      const rowOf = new Map(rows.flatMap((r, ri) => r.map((w) => [w, ri] as const)));
      const live = liveWords(line);
      for (const [j, { w, n }] of live.entries()) {
        const chip = `#w${i}_${n} .c`;
        const prev = line.words[n - 1];
        const at = t(w.start);
        if (prev && rowOf.get(prev) === rowOf.get(w)) {
          // slide from the word before: its chip's left edge and width, measured from this word
          const back = width(prev.text) + space;
          // the chip stays hidden until the word starts: only its place and size are set up front
          a += `tl.set("${chip}",{opacity:1},${at});tl.fromTo("${chip}",{left:${em(-back - CHIP_PAD_EM)},width:${em(width(prev.text) + 2 * CHIP_PAD_EM)}},{left:${em(-CHIP_PAD_EM)},width:${em(width(w.text) + 2 * CHIP_PAD_EM)},duration:${MOVE_S},ease:"power3.inOut"},${at});\n`;
        } else {
          // a fresh chip pops in; its opacity only changes through sets, so a hand-over to a word that
          // starts before the pop ends still hides it
          a += `tl.set("${chip}",{opacity:1},${at});tl.fromTo("${chip}",{scale:0.86},{scale:1,duration:0.1,ease:"power2.out"},${at});\n`;
        }
        // the chip before hands over; a word over before this composition starts had no chip shown
        if (prev && j > 0) a += `tl.set("#w${i}_${n - 1} .c",{opacity:0},${at});\n`;
      }
      return a;
    },
  };
}
