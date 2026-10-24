import { CAPTION_LOOKS } from "../styles.js";
import { CAPTION_FONT, escapeHtml, scaleOf, t, type LookInput, type LookParts } from "./shared.js";

/** Big, heavy, outlined capitals; the spoken word takes the accent colour with a short pop. */
export function look(o: LookInput): LookParts {
  const k = scaleOf(o);
  const px = (v: number) => `${Math.round(v * k)}px`;
  const { text, accent } = o.colors;
  const fontPx = Math.round((o.format === "landscape" ? 92 : 104) * k);
  const stroke = Math.round(12 * k);
  const css = `.block{font-family:${CAPTION_FONT};font-weight:${CAPTION_LOOKS.loud.weight};line-height:1.06;letter-spacing:.01em;word-spacing:.05em;color:${text};-webkit-text-stroke:${stroke}px #111;paint-order:stroke fill;text-shadow:0 ${px(10)} 0 rgba(0,0,0,.35)}
.w{display:inline-block;transform-origin:50% 70%}`;
  return {
    css,
    fontPx,
    letterSpacingEm: 0.01,
    wordSpacingEm: 0.05,
    // the stroke and the pop of an edge word reach past the row
    padX: Math.round(fontPx * 0.08) + stroke,
    wordMarkup: (w, id) => `<span class="w" id="${id}">${escapeHtml(w.text)}</span>`,
    animate: (line, i) => {
      let a = `tl.fromTo("#l${i} .block",{opacity:0},{opacity:1,duration:0.06},${t(line.start)});\n`;
      line.words.forEach((w, n) => {
        const id = `#w${i}_${n}`;
        a += `tl.set("${id}",{color:"${accent}"},${t(w.start)});tl.fromTo("${id}",{scale:1},{scale:1.12,duration:0.08,ease:"power2.out"},${t(w.start)});tl.to("${id}",{scale:1,duration:0.08,ease:"power2.in"},${t(w.start + 0.08)});tl.set("${id}",{color:"${text}"},${t(Math.max(w.end, w.start + 0.16))});\n`;
      });
      return a;
    },
  };
}
