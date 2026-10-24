import { CAPTION_LOOKS } from "../styles.js";
import {
  CAPTION_FONT,
  CAPTION_FONT_ACTIVE,
  escapeHtml,
  liveWords,
  scaleOf,
  t,
  type LookInput,
  type LookParts,
} from "./shared.js";

/** How long the roman and italic forms of a word take to cross over. */
const SWAP_S = 0.1;
const LETTER_SPACING_EM = -0.005;
/** The italic is about 5 % narrower than the roman; drawn this much larger it fills the same width. */
const ITALIC_SIZE = 1.05;
/** At that size its baseline would sit lower by this much of its own em; it is lifted back. */
const ITALIC_DROP_EM = 0.048;

/**
 * A quiet serif line; the spoken word turns italic in the accent colour and stays so until the next
 * word starts. The italic form is drawn over the roman one, so the row never reflows.
 */
export function look(o: LookInput): LookParts {
  const k = scaleOf(o);
  const px = (v: number) => `${Math.round(v * k)}px`;
  const { text, accent } = o.colors;
  const fontPx = Math.round((o.format === "landscape" ? 58 : 64) * k);
  const shade = `0 ${px(1)} ${px(2)} rgba(0,0,0,.55),0 ${px(2)} ${px(16)} rgba(0,0,0,.6),0 0 ${px(36)} rgba(0,0,0,.25)`;
  const css = `.block{font-family:${CAPTION_FONT};font-weight:${CAPTION_LOOKS.editoryal.weight};line-height:1.18;letter-spacing:${LETTER_SPACING_EM}em;color:${text};text-shadow:${shade}}
.w{display:inline-block;position:relative}
.i{position:absolute;left:50%;top:${-ITALIC_DROP_EM}em;transform:translateX(-50%);white-space:nowrap;font-size:${ITALIC_SIZE}em;font-family:${CAPTION_FONT_ACTIVE};font-weight:${CAPTION_LOOKS.editoryal.weightActive ?? CAPTION_LOOKS.editoryal.weight};color:${accent};opacity:0}`;
  return {
    css,
    fontPx,
    letterSpacingEm: LETTER_SPACING_EM,
    wordSpacingEm: 0,
    // the italic of an edge word leans a little past the row
    padX: Math.ceil(fontPx * 0.08),
    wordMarkup: (w, id) => {
      const s = escapeHtml(w.text);
      return `<span class="w" id="${id}"><span class="r">${s}</span><span class="i" aria-hidden="true">${s}</span></span>`;
    },
    animate: (line, i, timing) => {
      // a line that came in before this composition starts is already on screen
      let a =
        timing.enterS >= 0
          ? `tl.fromTo("#l${i} .block",{opacity:0,filter:"blur(${px(6)})"},{opacity:1,filter:"blur(0px)",duration:0.3,ease:"power2.out"},${t(timing.enterS)});\n`
          : "";
      for (const { w, n } of liveWords(line)) {
        const id = `#w${i}_${n}`;
        // a word already started when the composition begins is italic from its first frame
        const at = Math.max(0, w.start);
        const swap = w.start <= 0 ? 0.001 : SWAP_S;
        // the roman form goes at once and the italic inks in; on the way back the italic goes at once
        // and the roman returns. Each fade ends before the set that follows it, so none can undo it, and
        // none renders a from-state ahead of its time (the roman's return is a plain to).
        a += `tl.set("${id} .r",{opacity:0},${t(at)});tl.fromTo("${id} .i",{opacity:0},{opacity:1,duration:${t(swap)},ease:"power1.out"},${t(at)});`;
        const next = line.words[n + 1];
        if (next) {
          const back = Math.max(next.start, at + swap);
          a += `tl.set("${id} .i",{opacity:0},${t(back)});tl.to("${id} .r",{opacity:1,duration:${t(SWAP_S)},ease:"power1.out"},${t(back)});`;
        }
        a += "\n";
      }
      return a;
    },
  };
}
