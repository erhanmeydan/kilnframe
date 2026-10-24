import { CAPTION_LOOKS } from "../styles.js";
import type { CaptionWord } from "../types.js";
import { CAPTION_FONT, escapeHtml, scaleOf, t, type LookInput, type LookParts } from "./shared.js";

/** A word types its letters over this share of its length, so the last one lands before it ends. */
const TYPE_SHARE = 0.9;
/** The slowest a letter types, so a drawn-out word does not crawl. */
const MAX_STEP_S = 0.075;
/** A caret left waiting longer than this blinks, on and off every half second. */
const BLINK_S = 0.5;
/** Each row sits on its own strip; the strip reaches this far past the text on each side, in em. */
const STRIP_PAD_EM = 0.34;
/** The strip runs this far past the caret while a row is being typed, in em. */
const CARET_ROOM_EM = 0.16;
const LETTER_SPACING_EM = 0;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function letters(text: string): string[] {
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

/** When each letter of a word appears: evenly from the word's start, all in before its end. */
function letterTimes(w: CaptionWord): number[] {
  const n = letters(w.text).length;
  const step = Math.min(MAX_STEP_S, (TYPE_SHARE * Math.max(0, w.end - w.start)) / Math.max(n, 1));
  return Array.from({ length: n }, (_, j) => w.start + j * step);
}

/**
 * Monospaced text typed letter by letter, with a thin caret after the last letter typed. Each row sits
 * on its own square dark strip that runs out with the typing. A word is complete by the time it has
 * been said.
 */
export function look(o: LookInput): LookParts {
  const k = scaleOf(o);
  const { text, accent } = o.colors;
  const box = o.colors.box ?? (CAPTION_LOOKS.daktilo.colors.box as string);
  const fontPx = Math.round((o.format === "landscape" ? 52 : 58) * k);
  const measure = o.measureEm ?? ((s: string) => 0.6 * letters(s).length);
  const css = `.block{display:flex;flex-direction:column;align-items:center;gap:.1em;font-family:${CAPTION_FONT};font-weight:${CAPTION_LOOKS.daktilo.weight};line-height:1.32;letter-spacing:${LETTER_SPACING_EM}em;color:${text}}
.row{background:${box};padding:.06em ${STRIP_PAD_EM}em .08em;clip-path:inset(0 100% 0 0)}
.ch{display:inline-block;position:relative;opacity:0}
.ch.on{opacity:1}
.ch i{position:absolute;left:100%;top:.2em;bottom:.18em;width:.07em;margin-left:.02em;background:${accent};opacity:0}`;
  /** How far the strip of a row stays cut back from its right edge once `typed` of its text is in. */
  const cutEm = (rowText: string, typed: string) =>
    Math.max(0, measure(rowText) - measure(typed) - CARET_ROOM_EM);
  const clip = (em: number) => `"inset(0em ${em.toFixed(3)}em 0em 0em)"`;
  return {
    css,
    fontPx,
    letterSpacingEm: LETTER_SPACING_EM,
    wordSpacingEm: 0,
    // the strip reaches past the row
    padX: Math.ceil(fontPx * STRIP_PAD_EM),
    // letters typed before this composition starts are drawn already
    wordMarkup: (w, id) => {
      const times = letterTimes(w);
      const cells = letters(w.text).map(
        (ch, j) =>
          `<span class="ch${(times[j] as number) <= 0 ? " on" : ""}" id="${id}c${j}">${escapeHtml(ch)}<i></i></span>`,
      );
      return `<span class="w" id="${id}">${cells.join("")}</span>`;
    },
    animate: (line, i, timing, rows) => {
      // a line that came in before this composition starts is already on screen
      let a =
        timing.enterS >= 0
          ? `tl.fromTo("#l${i} .block",{clipPath:"inset(0% 100% 0% 0%)"},{clipPath:"inset(0% 0% 0% 0%)",duration:0.18,ease:"power2.out"},${t(timing.enterS)});\n`
          : "";
      // every letter still to type, in order, with how far its row's strip runs once it is in
      const typed: { id: string; at: number; row: string; cut: number }[] = [];
      rows.forEach((ws, r) => {
        const row = `#l${i} .row:nth-child(${r + 1})`;
        const rowText = ws.map((w) => w.text).join(" ");
        let before = "";
        let early: number | null = null;
        for (const w of ws) {
          const n = line.words.indexOf(w);
          const times = letterTimes(w);
          for (const [j, ch] of letters(w.text).entries()) {
            before += ch;
            const at = times[j] as number;
            const cut = cutEm(rowText, before);
            if (at <= 0) early = cut;
            else typed.push({ id: `#w${i}_${n}c${j}`, at, row, cut });
          }
          before += " ";
        }
        // a row partly typed before this composition starts shows its strip that far from the start
        if (early !== null) a += `tl.set("${row}",{clipPath:${clip(early)}},0);\n`;
      });
      typed.sort((x, y) => x.at - y.at);
      typed.forEach(({ id, at, row, cut }, j) => {
        a += `tl.set("${id}",{opacity:1},${t(at)});tl.set("${id} i",{opacity:1},${t(at)});tl.set("${row}",{clipPath:${clip(cut)}},${t(at)});`;
        const prev = typed[j - 1];
        if (prev) a += `tl.set("${prev.id} i",{opacity:0},${t(at)});`;
        // a caret left waiting blinks until the next letter or the end of the line
        const until = typed[j + 1]?.at ?? timing.endS;
        for (let b = at + BLINK_S, on = false; b < until - 0.1; b += BLINK_S, on = !on)
          a += `tl.set("${id} i",{opacity:${on ? 1 : 0}},${t(b)});`;
        a += "\n";
      });
      return a;
    },
  };
}
