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

/** The pop adds this much width to the spoken word (in em, shared by both sides), at most 12 %. */
const POP_EM = 0.16;
const POP_MAX = 1.12;
/** Space added between words: the room the pop takes, so the gap stays clear at its peak. */
const WORD_SPACING_EM = 0.1;
const LETTER_SPACING_EM = 0.01;

/** Big, heavy, outlined capitals; the spoken word takes the accent colour with a short pop. */
export function look(o: LookInput): LookParts {
  const k = scaleOf(o);
  const px = (v: number) => `${Math.round(v * k)}px`;
  const { text, accent } = o.colors;
  const fontPx = Math.round((o.format === "landscape" ? 92 : 104) * k);
  const stroke = Math.round(12 * k);
  // a word grows by the same width whatever its length: long words would otherwise reach their neighbours
  const popX = (word: string) => {
    const em = (o.measureEm?.(word) ?? 0.5 * word.length) + LETTER_SPACING_EM * [...word].length;
    return Math.min(POP_MAX, 1 + POP_EM / Math.max(em, 0.01)).toFixed(3);
  };
  const css = `.block{font-family:${CAPTION_FONT};font-weight:${CAPTION_LOOKS.loud.weight};line-height:1.06;letter-spacing:${LETTER_SPACING_EM}em;word-spacing:${WORD_SPACING_EM}em;color:${text};-webkit-text-stroke:${stroke}px #111;paint-order:stroke fill;text-shadow:0 ${px(10)} 0 rgba(0,0,0,.35)}
.w{display:inline-block;transform-origin:50% 70%}`;
  return {
    css,
    fontPx,
    letterSpacingEm: LETTER_SPACING_EM,
    wordSpacingEm: WORD_SPACING_EM,
    // the stroke and the pop of an edge word reach past the row
    padX: Math.round(fontPx * (POP_EM / 2)) + stroke,
    wordMarkup: (w, id) => `<span class="w" id="${id}">${escapeHtml(w.text)}</span>`,
    animate: (line, i, timing) => {
      // a line that came in before this composition starts is already on screen
      let a =
        timing.enterS >= 0
          ? `tl.fromTo("#l${i} .block",{opacity:0},{opacity:1,duration:0.06},${t(timing.enterS)});\n`
          : "";
      for (const { w, n } of liveWords(line)) {
        const id = `#w${i}_${n}`;
        a += `tl.set("${id}",{color:"${accent}"},${t(w.start)});tl.fromTo("${id}",{scaleX:1,scaleY:1},{scaleX:${popX(w.text)},scaleY:${POP_MAX},duration:0.08,ease:"power2.out"},${t(w.start)});tl.to("${id}",{scaleX:1,scaleY:1,duration:0.08,ease:"power2.in"},${t(w.start + 0.08)});tl.set("${id}",{color:"${text}"},${t(Math.max(w.end, w.start + 0.16))});\n`;
      }
      return a;
    },
  };
}
