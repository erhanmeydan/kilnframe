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

/** Navy card, cream text; a clay underline grows under the spoken word. */
export function look(o: LookInput): LookParts {
  const k = scaleOf(o);
  const px = (v: number) => `${Math.round(v * k)}px`;
  const { text, accent } = o.colors;
  const box = o.colors.box ?? (CAPTION_LOOKS["kil-lacivert"].colors.box as string);
  const fontPx = Math.round(56 * k);
  const padX = Math.round(34 * k);
  const css = `.block{background:${box};border-radius:${px(22)};padding:${px(20)} ${padX}px ${px(26)};box-shadow:0 ${px(18)} ${px(40)} rgba(10,14,24,.35);font-family:${CAPTION_FONT};font-weight:${CAPTION_LOOKS["kil-lacivert"].weight};line-height:1.32;letter-spacing:-.02em;color:${text}}
.w{display:inline-block;position:relative}
.w i{position:absolute;left:0;right:0;bottom:${px(-6)};height:${px(7)};border-radius:${px(4)};background:${accent};transform:scaleX(0);transform-origin:0 50%}`;
  return {
    css,
    fontPx,
    letterSpacingEm: -0.02,
    wordSpacingEm: 0,
    padX,
    wordMarkup: (w, id) => `<span class="w" id="${id}">${escapeHtml(w.text)}<i></i></span>`,
    animate: (line, i, timing) => {
      // a line that came in before this composition starts is already on screen
      let a =
        timing.enterS >= 0
          ? `tl.fromTo("#l${i} .block",{opacity:0,y:${Math.round(10 * k)}},{opacity:1,y:0,duration:0.16,ease:"power2.out"},${t(timing.enterS)});\n`
          : "";
      for (const { w, n } of liveWords(line)) {
        const id = `#w${i}_${n} i`;
        a += `tl.fromTo("${id}",{scaleX:0},{scaleX:1,duration:${t(Math.max(0.12, w.end - w.start))},ease:"power1.out"},${t(w.start)});tl.set("${id}",{scaleX:0},${t(w.end)});\n`;
      }
      return a;
    },
  };
}
