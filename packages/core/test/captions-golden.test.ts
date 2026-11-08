// Golden files: the HTML the nine looks make today, recorded before the caption extras (emphasis, emoji, speaker
// colours, max words). A doc that sets none of the new fields must keep producing these exact bytes.
// Record again only on purpose: `vitest -u test/captions-golden.test.ts`.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captionHtml, captionSegments, type CaptionDoc } from "../src/captions/compose.js";
import { CAPTION_LOOKS } from "../src/captions/styles.js";
import type { CaptionLine, CaptionStyleId } from "../src/captions/types.js";

const vendorFonts = join(import.meta.dirname, "../../../vendor/fonts");
const looks = Object.keys(CAPTION_LOOKS) as CaptionStyleId[];
const shapes = {
  portrait: { width: 1080, height: 1920 },
  landscape: { width: 1920, height: 1080 },
};
const snap = (name: string) => join(import.meta.dirname, "__snapshots__", `captions-golden-${name}.html`);

function line(text: string, start: number, end: number): CaptionLine {
  const parts = text.split(" ").filter(Boolean);
  const step = (end - start) / parts.length;
  return {
    start,
    end,
    text,
    changed: false,
    words: parts.map((t, i) => ({ text: t, start: start + i * step, end: start + (i + 1) * step })),
  };
}

/** Three lines: one crossing the hide span, one whose first word starts before 0 (a second segment's line). */
function fixture(shape: keyof typeof shapes, over: Partial<CaptionDoc> = {}): CaptionDoc {
  const crossing = line("the quick brown fox jumps over", 3, 6);
  const early = line("lazy dogs sleep", 8.2, 9.4);
  const first = (early.words[0] as CaptionLine["words"][number]).start;
  (early.words[0] as CaptionLine["words"][number]).start = first - 8.5;
  return {
    lines: [line("Hello and welcome back", 0.5, 2.5), crossing, early],
    language: "en",
    glossary: [],
    durationS: 10,
    fps: "25",
    hideSpans: [{ startS: 5, endS: 5.5 }],
    ...shapes[shape],
    ...over,
  };
}

describe("caption HTML golden files", () => {
  for (const look of looks) {
    for (const shape of Object.keys(shapes) as (keyof typeof shapes)[]) {
      it(`${look} ${shape}`, async () => {
        await expect(captionHtml(fixture(shape), look, CAPTION_LOOKS[look].colors)).toMatchFileSnapshot(
          snap(`${look}-${shape}`),
        );
      });
    }
  }

  it("a font of the user's own", async () => {
    const own = join(vendorFonts, CAPTION_LOOKS.loud.font);
    await expect(
      captionHtml(fixture("portrait"), "kil-lacivert", CAPTION_LOOKS["kil-lacivert"].colors, undefined, own),
    ).toMatchFileSnapshot(snap("own-font"));
  });

  it("segment 2 of captionSegments(doc, 2)", async () => {
    const doc = fixture("landscape");
    const segments = captionSegments(doc, 2);
    expect(segments.length).toBeGreaterThan(2);
    await expect(
      captionHtml(doc, "karaoke", CAPTION_LOOKS.karaoke.colors, segments[1]),
    ).toMatchFileSnapshot(snap("segment-2"));
  });
});
