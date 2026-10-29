import { CAPTION_LOOKS } from "../styles.js";
import { CAPTION_FONT, escapeHtml, scaleOf, t, type LookInput, type LookParts } from "./shared.js";

const LETTER_SPACING_EM = 0.01;

/**
 * One quiet row of lower-case text in a soft off-white over a wide, faint shade. Nothing moves: the
 * line only fades in.
 */
export function look(o: LookInput): LookParts {
  const k = scaleOf(o);
  const px = (v: number) => `${Math.round(v * k)}px`;
  const fontPx = Math.round((o.format === "landscape" ? 48 : 54) * k);
  const css = `.block{font-family:${CAPTION_FONT};font-weight:${CAPTION_LOOKS.sakin.weight};line-height:1.3;letter-spacing:${LETTER_SPACING_EM}em;color:${o.colors.text};position:relative;z-index:0;text-shadow:0 ${px(1)} ${px(2)} rgba(0,0,0,.5),0 0 ${px(14)} rgba(0,0,0,.4)}
.block::before{content:"";position:absolute;z-index:-1;inset:-.3em -.9em;border-radius:2em;background:rgba(6,8,12,.34);filter:blur(${px(40)})}`;
  return {
    css,
    fontPx,
    letterSpacingEm: LETTER_SPACING_EM,
    wordSpacingEm: 0,
    padX: Math.round(4 * k),
    wordMarkup: (w, id) => `<span class="w" id="${id}">${escapeHtml(w.text)}</span>`,
    // a line that came in before this composition starts is already on screen
    animate: (_line, i, { enterS }) =>
      enterS >= 0
        ? `tl.fromTo("#l${i} .block",{opacity:0},{opacity:1,duration:0.24,ease:"power1.out"},${t(enterS)});\n`
        : "",
  };
}
