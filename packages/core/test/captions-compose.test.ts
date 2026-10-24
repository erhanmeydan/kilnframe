import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  blockRows,
  buildCaptionProject,
  captionHtml,
  captionLines,
  captionWindows,
  type CaptionDoc,
} from "../src/captions/compose.js";
import { nextCaptionNumber } from "../src/captions/render.js";
import { CAPTION_LOOKS } from "../src/captions/styles.js";
import type { CaptionLine, CaptionStyleId } from "../src/captions/types.js";
import { safeArea } from "../src/safe-area.js";

const vendorFonts = join(import.meta.dirname, "../../../vendor/fonts");
const LOOKS: CaptionStyleId[] = ["kil-lacivert", "loud", "bant"];

function line(text: string, start: number, end: number): CaptionLine {
  const parts = text.split(" ").filter(Boolean);
  const step = parts.length ? (end - start) / parts.length : 0;
  return {
    start,
    end,
    text,
    changed: false,
    words: parts.map((t, i) => ({ text: t, start: start + i * step, end: start + (i + 1) * step })),
  };
}

function doc(lines: CaptionLine[], over: Partial<CaptionDoc> = {}): CaptionDoc {
  return {
    lines,
    language: "tr",
    glossary: [],
    durationS: 10,
    width: 1080,
    height: 1920,
    fps: "25",
    hideSpans: [],
    ...over,
  };
}

const sample = doc([
  line("Yapay zekâ ile video üretirken", 0.2, 2.6),
  line("kamera hareketi hep sorundu.", 2.6, 4.0),
  line("Model her seferinde başka türlü", 6.0, 8.0),
]);

function fontSizes(html: string): number[] {
  return [...html.matchAll(/class="block" style="font-size:([\d.]+)px"/g)].map((m) => Number(m[1]));
}

describe("caption placement", () => {
  it.each(LOOKS)("centres %s portrait captions between 65 %% and 72 %% of the height", (look) => {
    const html = captionHtml(sample, look, CAPTION_LOOKS[look].colors);
    const top = Number(/\.line\{[^}]*top:(\d+)px/.exec(html)?.[1]);
    expect(top / 1920).toBeGreaterThanOrEqual(0.65);
    expect(top / 1920).toBeLessThanOrEqual(0.72);
    expect(html).toMatch(/\.line\{[^}]*align-items:center/);
  });

  it("puts landscape captions in the lower third, on the safe area's bottom edge", () => {
    const html = captionHtml(
      { ...sample, width: 1920, height: 1080 },
      "bant",
      CAPTION_LOOKS.bant.colors,
    );
    const bottom = Number(/\.line\{[^}]*bottom:(\d+)px/.exec(html)?.[1]);
    expect(bottom).toBe(safeArea("landscape", 1920, 1080).bottom);
  });
});

describe("captionWindows", () => {
  it("holds a line 0.35 s after its last word when the next one starts later", () => {
    const w = captionWindows([line("a b", 2, 4), line("c", 6, 7)], 10, []);
    expect(w[0]).toEqual([{ startS: 2, endS: 4.35 }]);
  });

  it("ends a line when the next one starts", () => {
    const w = captionWindows([line("a b", 2, 4), line("c", 4.1, 5)], 10, []);
    expect(w[0]?.[0]?.endS).toBeCloseTo(4.1);
  });

  it("clips lines to the parts outside the hidden spans", () => {
    const w = captionWindows([line("a", 3, 9), line("b", 9.5, 9.6)], 10, [{ startS: 4, endS: 8 }]);
    expect(w[0]).toEqual([
      { startS: 3, endS: 4 },
      { startS: 8, endS: 9.35 },
    ]);
    const inside = captionWindows([line("a", 5, 7)], 10, [{ startS: 4, endS: 8 }]);
    expect(inside[0]).toEqual([]);
  });

  it("never runs past the end of the doc", () => {
    expect(captionWindows([line("a", 9, 9.9)], 10, [])[0]).toEqual([{ startS: 9, endS: 10 }]);
  });
});

describe("caption composition", () => {
  it("leaves a fully hidden line out of the composition", () => {
    const html = captionHtml(
      doc([line("görünür", 1, 2), line("gizli kalır", 5, 7)], {
        hideSpans: [{ startS: 4, endS: 8 }],
      }),
      "bant",
      CAPTION_LOOKS.bant.colors,
    );
    expect(html).toContain("görünür");
    expect(html).not.toContain("gizli");
  });

  it("drops emptied and wordless lines", () => {
    const lines = [line("bir", 1, 2), { ...line("", 2, 3), text: " " }, line("iki", 3, 4)];
    expect(captionLines(lines).map((l) => l.text)).toEqual(["bir", "iki"]);
    const html = captionHtml(doc(lines), "kil-lacivert", CAPTION_LOOKS["kil-lacivert"].colors);
    expect(html.match(/class="line"/g)).toHaveLength(2);
  });

  it("writes uppercase looks with the Turkish rule and keeps glossary names", () => {
    const d = doc([line("TopView'in içinde istanbul", 1, 3)], { glossary: ["TopView"] });
    const html = captionHtml(d, "loud", CAPTION_LOOKS.loud.colors);
    expect(html).toContain("TOPVIEW'İN");
    expect(html).toContain("İÇİNDE");
    expect(html).toContain("İSTANBUL");
    const kil = captionHtml(d, "kil-lacivert", CAPTION_LOOKS["kil-lacivert"].colors);
    expect(kil).toContain("TopView'in");
  });

  it("escapes markup in the text", () => {
    const html = captionHtml(doc([line("a<b & c", 1, 2)]), "bant", CAPTION_LOOKS.bant.colors);
    expect(html).toContain("a&lt;b");
    expect(html).toContain("&amp;");
  });

  it("is seek-safe: one paused timeline, no clocks", () => {
    for (const look of LOOKS) {
      const html = captionHtml(sample, look, CAPTION_LOOKS[look].colors);
      expect(html).toContain("gsap.timeline({ paused: true })");
      expect(html).toContain('window.__timelines["captions"] = tl');
      expect(html).toContain('data-composition-id="captions"');
      expect(html).not.toMatch(/requestAnimationFrame|setTimeout|setInterval|Date\.now/);
    }
  });

  it("uses the colours it is given", () => {
    const html = captionHtml(sample, "loud", { text: "#fafafa", accent: "#00c2a8" });
    expect(html).toContain("#00c2a8");
    expect(html).toContain("#fafafa");
  });

  it("draws a block smaller when a single word is wider than the frame allows", () => {
    const d = doc([
      line("kısa", 1, 2),
      line("Muvaffakiyetsizleştiricileştiriveremeyebileceklerimizdenmişsinizcesine", 3, 5),
    ]);
    for (const look of LOOKS) {
      const [normal, long] = fontSizes(captionHtml(d, look, CAPTION_LOOKS[look].colors));
      expect(long).toBeLessThan(normal as number);
    }
  });

  it("keeps an ordinary line at the look's size", () => {
    const sizes = fontSizes(captionHtml(sample, "loud", CAPTION_LOOKS.loud.colors));
    expect(new Set(sizes).size).toBe(1);
  });

  it("refuses looks that are not built yet", () => {
    expect(() => captionHtml(sample, "editoryal", CAPTION_LOOKS.editoryal.colors)).toThrow(
      /not available/,
    );
  });
});

describe("blockRows", () => {
  it("keeps a block that fits on one row", () => {
    expect(blockRows(["kısa", "satır"], 16, 2)).toEqual([["kısa", "satır"]]);
  });

  it("breaks with the least overflow when no break keeps both rows short enough", () => {
    expect(blockRows("Model her seferinde başka türlü".split(" "), 16, 2)).toEqual([
      ["Model", "her", "seferinde"],
      ["başka", "türlü"],
    ]);
  });

  it("chooses the most even break", () => {
    expect(blockRows(["Yapay", "zekâ", "ile", "video", "üretirken"], 16, 2)).toEqual([
      ["Yapay", "zekâ", "ile"],
      ["video", "üretirken"],
    ]);
  });

  it("keeps one row for one-row looks", () => {
    expect(blockRows(["a", "b", "c"], 1, 1)).toEqual([["a", "b", "c"]]);
  });
});

describe("buildCaptionProject", () => {
  it.each(LOOKS)(
    "copies the %s vendor font next to index.html and loads nothing remote",
    (look) => {
      const dir = mkdtempSync(join(tmpdir(), "kf-caption-project-"));
      buildCaptionProject(sample, look, CAPTION_LOOKS[look].colors, dir);
      const html = readFileSync(join(dir, "index.html"), "utf8");
      expect(html).not.toMatch(/https?:/);
      expect(html).toContain('src:url("font.ttf")');
      expect(html).toContain(`font-weight:${CAPTION_LOOKS[look].weight}}`);
      expect(readFileSync(join(dir, "font.ttf"))).toEqual(
        readFileSync(join(vendorFonts, CAPTION_LOOKS[look].font)),
      );
      expect(readFileSync(join(dir, "gsap.min.js")).length).toBeGreaterThan(1000);
    },
  );
});

describe("nextCaptionNumber", () => {
  it("counts up from the files already in the folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "kf-caption-n-"));
    expect(nextCaptionNumber(dir)).toBe(1);
    expect(nextCaptionNumber(join(dir, "missing"))).toBe(1);
  });
});
