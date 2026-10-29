import { CAPTION_LOOKS } from "../styles.js";
import { CAPTION_FONT, escapeHtml, scaleOf, t, type LookInput, type LookParts } from "./shared.js";

/** Plain text on a translucent dark band; the block eases in and out. */
export function look(o: LookInput): LookParts {
  const k = scaleOf(o);
  const px = (v: number) => `${Math.round(v * k)}px`;
  const box = o.colors.box ?? (CAPTION_LOOKS.bant.colors.box as string);
  const fontPx = Math.round(54 * k);
  const padX = Math.round(28 * k);
  const css = `.block{background:${box};border-radius:${px(14)};padding:${px(14)} ${padX}px ${px(16)};font-family:${CAPTION_FONT};font-weight:${CAPTION_LOOKS.bant.weight};line-height:1.28;letter-spacing:-.01em;color:${o.colors.text}}`;
  return {
    css,
    fontPx,
    letterSpacingEm: -0.01,
    wordSpacingEm: 0,
    padX,
    wordMarkup: (w, id) => `<span class="w" id="${id}">${escapeHtml(w.text)}</span>`,
    animate: (_line, i, { enterS, endS }) => {
      const sel = `"#l${i} .block"`;
      const out = Math.max(enterS + 0.2, endS - 0.14);
      // a line that came in before this composition starts is already on screen
      const enter =
        enterS >= 0
          ? `tl.fromTo(${sel},{opacity:0,y:${Math.round(8 * k)}},{opacity:1,y:0,duration:0.2,ease:"power2.out"},${t(enterS)});`
          : "";
      return `${enter}tl.to(${sel},{opacity:0,duration:${t(Math.min(0.14, endS - out))},ease:"power1.in"},${t(out)});\n`;
    },
  };
}
