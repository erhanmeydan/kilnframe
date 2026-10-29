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

/** A word comes in from this scale; the ease overshoots 1 by about 2 %, kept clear by the word spacing. */
const FROM_SCALE = 0.8;
const WORD_SPACING_EM = 0.04;
const LETTER_SPACING_EM = -0.01;

/** Heavy white text in a black outline, no colour; each word grows and fades in as it is said. */
export function look(o: LookInput): LookParts {
  const k = scaleOf(o);
  const { text } = o.colors;
  const outline = o.colors.box ?? (CAPTION_LOOKS.dinamik.colors.box as string);
  const fontPx = Math.round((o.format === "landscape" ? 70 : 78) * k);
  const stroke = Math.round(11 * k);
  const css = `.block{font-family:${CAPTION_FONT};font-weight:${CAPTION_LOOKS.dinamik.weight};line-height:1.14;letter-spacing:${LETTER_SPACING_EM}em;word-spacing:${WORD_SPACING_EM}em;color:${text};-webkit-text-stroke:${stroke}px ${outline};paint-order:stroke fill;text-shadow:0 ${Math.round(7 * k)}px 0 ${outline}}
.w{display:inline-block;transform-origin:50% 75%;opacity:0}
.w.said{opacity:1}`;
  return {
    css,
    fontPx,
    letterSpacingEm: LETTER_SPACING_EM,
    wordSpacingEm: WORD_SPACING_EM,
    // half the stroke shows outside the glyphs
    padX: Math.ceil(stroke / 2),
    // a word said before this composition starts is already in
    wordMarkup: (w, id) =>
      `<span class="w${w.end <= 0 ? " said" : ""}" id="${id}">${escapeHtml(w.text)}</span>`,
    animate: (line, i, timing) => {
      // a line that came in before this composition starts is already on screen
      let a =
        timing.enterS >= 0
          ? `tl.fromTo("#l${i} .block",{opacity:0},{opacity:1,duration:0.08},${t(timing.enterS)});\n`
          : "";
      for (const { w, n } of liveWords(line)) {
        // a word already started when the composition begins is drawn in full from its first frame
        const at = w.start <= 0 ? 0 : w.start;
        a += `tl.fromTo("#w${i}_${n}",{opacity:0,scale:${FROM_SCALE},y:${Math.round(8 * k)}},{opacity:1,scale:1,y:0,duration:${w.start <= 0 ? "0.001" : "0.16"},ease:"back.out(1.6)"},${t(at)});\n`;
      }
      return a;
    },
  };
}
