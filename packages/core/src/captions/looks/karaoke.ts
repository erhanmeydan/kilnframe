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

/** Words not said yet are drawn at this opacity. */
const DIM = 0.48;
/** The accent fills a word from left to right over its length, within these bounds. */
const FILL_MIN_S = 0.08;
const FILL_MAX_S = 0.9;
const LETTER_SPACING_EM = -0.01;

/**
 * The whole line shows with its words dim; a word turns bright as it is said and the accent fills it
 * from left to right, so the said part of the line reads in the accent colour.
 */
export function look(o: LookInput): LookParts {
  const k = scaleOf(o);
  const px = (v: number) => `${Math.round(v * k)}px`;
  const { text, accent } = o.colors;
  const fontPx = Math.round((o.format === "landscape" ? 64 : 70) * k);
  const css = `.block{position:relative;z-index:0;font-family:${CAPTION_FONT};font-weight:${CAPTION_LOOKS.karaoke.weight};line-height:1.2;letter-spacing:${LETTER_SPACING_EM}em;color:${text};text-shadow:0 ${px(2)} ${px(4)} rgba(0,0,0,.5)}
.block::before{content:"";position:absolute;z-index:-1;inset:-.28em -.5em;border-radius:.7em;background:rgba(6,8,12,.6);filter:blur(${px(26)})}
.w{display:inline-block;position:relative;opacity:${DIM}}
.f{position:absolute;left:0;top:0;bottom:0;width:0;overflow:hidden;white-space:nowrap;color:${accent};text-shadow:none}
.w.said{opacity:1}
.w.said .f{width:100%}`;
  return {
    css,
    fontPx,
    letterSpacingEm: LETTER_SPACING_EM,
    wordSpacingEm: 0,
    padX: Math.round(8 * k),
    // a word said before this composition starts is already bright and filled
    wordMarkup: (w, id) => {
      const s = escapeHtml(w.text);
      return `<span class="w${w.end <= 0 ? " said" : ""}" id="${id}">${s}<span class="f" aria-hidden="true">${s}</span></span>`;
    },
    animate: (line, i, timing) => {
      // a line that came in before this composition starts is already on screen
      let a =
        timing.enterS >= 0
          ? `tl.fromTo("#l${i} .block",{opacity:0,y:${Math.round(8 * k)}},{opacity:1,y:0,duration:0.16,ease:"power2.out"},${t(timing.enterS)});\n`
          : "";
      for (const { w, n } of liveWords(line)) {
        const id = `#w${i}_${n}`;
        const fill = Math.min(FILL_MAX_S, Math.max(FILL_MIN_S, w.end - w.start));
        a += `tl.set("${id}",{opacity:1},${t(w.start)});tl.fromTo("${id} .f",{width:"0%"},{width:"100%",duration:${t(fill)},ease:"none"},${t(w.start)});\n`;
      }
      return a;
    },
  };
}
