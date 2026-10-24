import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fontkit from "fontkit";
import { beforeAll, describe, expect, it } from "vitest";
import {
  blockRows,
  buildCaptionProject,
  captionHtml,
  captionLines,
  captionSegments,
  captionWindows,
  type CaptionDoc,
  type CaptionSegment,
  type TimeSpan,
} from "../src/captions/compose.js";
import { nextCaptionNumber } from "../src/captions/render.js";
import { CAPTION_LOOKS } from "../src/captions/styles.js";
import type { CaptionLine, CaptionStyleId } from "../src/captions/types.js";
import { safeArea } from "../src/safe-area.js";

const vendorFonts = join(import.meta.dirname, "../../../vendor/fonts");
const LOOKS: CaptionStyleId[] = ["kil-lacivert", "loud", "dinamik", "hap", "karaoke", "bant"];

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

describe("captionSegments", () => {
  // ~1000 lines over an hour, with hidden spans, some lines crossing segment edges
  const hour = (() => {
    const lines: CaptionLine[] = [];
    for (let k = 0; k < 1000; k++) {
      const start = k * 3.6 + (k % 7) * 0.05;
      lines.push(line(`satır ${k} burada`, start, start + 2.9 + (k % 3) * 0.4));
    }
    return doc(lines, {
      durationS: 3600,
      fps: "30000/1001",
      hideSpans: [
        { startS: 478, endS: 483 },
        { startS: 1500, endS: 1530.5 },
      ],
    });
  })();

  it("keeps a doc shorter than one segment in one piece", () => {
    const segments = captionSegments(sample, 480);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ startS: 0, endS: 10 });
  });

  it("cuts on frame edges into touching segments that cover the doc", () => {
    const segments = captionSegments(hour, 480);
    expect(segments).toHaveLength(8);
    expect(segments[0]?.startS).toBe(0);
    expect(segments.at(-1)?.endS).toBe(3600);
    segments.forEach((s, k) => {
      if (k) expect(s.startS).toBe(segments[k - 1]?.endS);
      const frames = (s.startS * 30000) / 1001;
      expect(Math.abs(frames - Math.round(frames))).toBeLessThan(1e-6);
    });
  });

  it("joins back to the whole doc's windows with no gaps or doubles at the edges", () => {
    const lines = captionLines(hour.lines);
    const whole = captionWindows(lines, hour.durationS, hour.hideSpans);
    const joined: TimeSpan[][] = lines.map(() => []);
    let entrances = 0;
    for (const s of captionSegments(hour, 480)) {
      for (const e of s.entries) {
        expect(e.line.text).toBe(lines[e.index]?.text);
        expect(e.line.start).toBeCloseTo((lines[e.index] as CaptionLine).start - s.startS, 9);
        if (e.timing.enterS >= 0 && e.timing.enterS < s.endS - s.startS) entrances++;
        for (const w of e.windows) {
          expect(w.startS).toBeGreaterThanOrEqual(0);
          expect(w.endS).toBeLessThanOrEqual(s.endS - s.startS + 1e-9);
          const back = { startS: w.startS + s.startS, endS: w.endS + s.startS };
          const list = joined[e.index] as TimeSpan[];
          const last = list.at(-1);
          expect(last && back.startS < last.endS - 1e-9).toBeFalsy();
          // a window cut at an edge continues in the next segment
          if (last && Math.abs(last.endS - back.startS) < 1e-9) last.endS = back.endS;
          else list.push(back);
        }
      }
    }
    joined.forEach((list, i) => {
      const want = whole[i] as TimeSpan[];
      expect(list).toHaveLength(want.length);
      list.forEach((w, k) => {
        expect(w.startS).toBeCloseTo((want[k] as TimeSpan).startS, 9);
        expect(w.endS).toBeCloseTo((want[k] as TimeSpan).endS, 9);
      });
    });
    // each shown line enters once, in the segment where it first appears
    expect(entrances).toBe(whole.filter((w) => w.length).length);
  });

  it("writes a segment's composition with only its lines, timed from its start", () => {
    const segments = captionSegments(hour, 480);
    const second = segments[1] as CaptionSegment;
    const html = captionHtml(hour, "bant", CAPTION_LOOKS.bant.colors, second);
    expect(html).toContain(
      `data-duration="${(second.endS - second.startS).toFixed(6).replace(/\.?0+$/, "")}"`,
    );
    expect(html).not.toContain(">satır 0 <");
    expect(html.match(/class="line"/g)).toHaveLength(second.entries.length);
    expect(html).not.toMatch(/},-/);
  });
});

describe("entrance", () => {
  it.each(LOOKS)("plays the %s entrance when a hidden span covering the start ends", (look) => {
    const d = doc([line("gizli başlayan satır", 3, 7)], { hideSpans: [{ startS: 2, endS: 4.5 }] });
    const html = captionHtml(d, look, CAPTION_LOOKS[look].colors);
    const entrance = /tl\.fromTo\("#l0 \.block",[^;]*?,([\d.]+)\);/.exec(html);
    expect(Number(entrance?.[1])).toBe(4.5);
  });

  it.each(LOOKS)(
    "skips the %s entrance and past words for a line that came in before the segment",
    (look) => {
      const d = doc([line("kenarı geçen satır burada", 9, 13)], { durationS: 20 });
      const [, second] = captionSegments(d, 10);
      const html = captionHtml(d, look, CAPTION_LOOKS[look].colors, second);
      expect(html).not.toMatch(/tl\.fromTo\("#l0 \.block"/);
      // word 0 (9-10 s) is over before the segment starts at 10 s; word 1 (10-11 s) still plays
      expect(html).not.toContain('"#w0_0');
      if (look !== "bant") expect(html).toContain('"#w0_1');
    },
  );
});

describe("Loud's pop", () => {
  const anton = fontkit.openSync(join(vendorFonts, CAPTION_LOOKS.loud.font)) as fontkit.Font;
  const em = (s: string) =>
    anton.layout(s).positions.reduce((a, p) => a + p.xAdvance, 0) / anton.unitsPerEm;
  const words = "ÇÜNKÜ ELİNDE BİR REFERANS YOK. KULLANMAYACAĞIM. O".split(" ");
  const d = doc([line(words.join(" "), 1, 8)], { language: "tr" });

  it.each([
    [1080, 1920],
    [1920, 1080],
    [1080, 1080],
  ])("keeps a clear gap to the neighbours at the peak of the pop (%ix%i)", (width, height) => {
    const html = captionHtml({ ...d, width, height }, "loud", CAPTION_LOOKS.loud.colors);
    const ws = Number(/word-spacing:([\d.]+)em/.exec(html)?.[1]);
    const ls = Number(/letter-spacing:([\d.]+)em/.exec(html)?.[1]);
    const stroke = Number(/-webkit-text-stroke:(\d+)px/.exec(html)?.[1]);
    const size = Number(/class="block" style="font-size:([\d.]+)px"/.exec(html)?.[1]);
    const restGap = em(" ") + ls + ws - stroke / size;
    const gaps: number[] = [];
    words.forEach((word, n) => {
      const sx = Number(
        new RegExp(`"#w0_${n}",\\{scale(?:X)?:1[^}]*\\},\\{scaleX:([\\d.]+)`).exec(html)?.[1],
      );
      expect(sx).toBeGreaterThan(1);
      // the popped word grows half its extra width on each side
      gaps.push(restGap - ((sx - 1) * (em(word) + ls * [...word].length)) / 2);
    });
    // clear: over a tenth of an em of visible space next to any popped word
    expect(Math.min(...gaps)).toBeGreaterThan(0.1);
    // even: every word but the shortest grows by the same width, so its gaps are the same; a short
    // word grows less and never comes closer
    const long = gaps.filter((_, n) => em(words[n] as string) > 1.4);
    expect(long.length).toBeGreaterThan(3);
    expect(Math.max(...long) - Math.min(...long)).toBeLessThan(0.002);
    expect(Math.min(...gaps)).toBeCloseTo(Math.min(...long), 6);
  });

  it("measures the pop room into the row width, so a row that fits only without it is drawn smaller", () => {
    const parts = { loud: CAPTION_LOOKS.loud };
    const wide = doc([line("AAAAAA BBBBBB CCCCCC DDDDDD EEEEEE FFFFFF GGG", 1, 4)]);
    const html = captionHtml(wide, "loud", parts.loud.colors);
    const size = Number(/class="block" style="font-size:([\d.]+)px"/.exec(html)?.[1]);
    const rows = [...html.matchAll(/<div class="row">(.*?)<\/div>/g)].map((m) =>
      m[1]!.replace(/<[^>]+>/g, ""),
    );
    const ws = Number(/word-spacing:([\d.]+)em/.exec(html)?.[1]);
    const widest = Math.max(
      ...rows.map((r) => (em(r) + 0.01 * [...r].length + ws * (r.split(" ").length - 1)) * size),
    );
    const safe = safeArea("portrait", 1080, 1920);
    const pad = Math.round(104 * 0.08) + 12;
    expect(widest).toBeLessThanOrEqual(1080 - safe.left - safe.right - 2 * pad + 0.5);
  });
});

describe("Kil Lacivert underline", () => {
  it("spans the whole word within 0.15 s of the word's start and holds until its end", () => {
    const d = doc([line("referans yok", 10, 12)], { durationS: 20 });
    const html = captionHtml(d, "kil-lacivert", CAPTION_LOOKS["kil-lacivert"].colors);
    const draw =
      /tl\.fromTo\("#w0_0 i",\{scaleX:0\},\{scaleX:1,duration:([\d.]+)[^}]*\},([\d.]+)\)/.exec(
        html,
      );
    expect(Number(draw?.[2])).toBe(10);
    expect(Number(draw?.[1]) + Number(draw?.[2])).toBeLessThanOrEqual(10.15);
    expect(html).toContain('tl.set("#w0_0 i",{scaleX:0},11.000)');
    // the bar is as wide as the word box
    expect(html).toMatch(/\.w i\{position:absolute;left:0;right:0;/);
  });
});

describe("Dinamik", () => {
  it("uses no colour but the text colour and its outline", () => {
    const html = captionHtml(sample, "dinamik", {
      text: "#fafafa",
      accent: "#00c2a8",
      box: "#101010",
    });
    const colours = html.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/gi) ?? [];
    expect(colours.length).toBeGreaterThan(0);
    expect(new Set(colours.map((c) => c.toLowerCase()))).toEqual(new Set(["#fafafa", "#101010"]));
  });

  it("brings each word in with a small growth and fade when it is said", () => {
    const d = doc([line("referans yok", 10, 12)], { durationS: 20 });
    const html = captionHtml(d, "dinamik", CAPTION_LOOKS.dinamik.colors);
    expect(html).toMatch(/\.w\{[^}]*opacity:0[;}]/);
    const word =
      /tl\.fromTo\("#w0_1",\{opacity:0,scale:(0\.\d+)[^}]*\},\{opacity:1,scale:1[^}]*\},([\d.]+)\)/.exec(
        html,
      );
    expect(Number(word?.[1])).toBeGreaterThan(0.7);
    expect(Number(word?.[2])).toBe(11);
  });
});

describe("Hap", () => {
  const colors = { text: "#ffffff", accent: "#123abc" };
  const d = doc([line("bir iki üç", 10, 13)], { durationS: 20 });
  let html = "";
  beforeAll(() => {
    html = captionHtml(d, "hap", colors);
  });

  it("puts the spoken word on a chip filled with the accent colour", () => {
    expect(html).toMatch(/\.c\{[^}]*background:#123abc/);
    for (const [n, at] of [
      [0, 10],
      [1, 11],
      [2, 12],
    ])
      expect(html).toMatch(
        new RegExp(
          `tl\\.set\\("#w0_${n} \\.c",\\{opacity:1\\},${at}\\.000\\)|tl\\.fromTo\\("#w0_${n} \\.c",\\{opacity:0[^}]*\\},\\{opacity:1[^}]*\\},${at}\\.000\\)`,
        ),
      );
  });

  it("moves the chip from the word before and hides that word's chip", () => {
    expect(html).toMatch(/tl\.fromTo\("#w0_1 \.c",\{left:"-[\d.]+em",width:"[\d.]+em"\}/);
    // the slide only moves the chip: it stays hidden until its word starts
    expect(html).not.toMatch(/tl\.fromTo\("#w0_[12] \.c",\{opacity:1/);
    expect(html).toContain('tl.set("#w0_0 .c",{opacity:0},11.000)');
  });

  it("brings the chip in afresh on a new row instead of sliding across rows", () => {
    const two = doc([line("Model her seferinde başka türlü", 1, 6)]);
    const h = captionHtml(two, "hap", colors);
    // "başka" opens the second row
    expect(h).not.toMatch(/tl\.fromTo\("#w0_3 \.c",\{left/);
    expect(h).toMatch(/tl\.fromTo\("#w0_3 \.c",\{scale:/);
  });

  it("hides a fresh chip at the next word even when that word starts before the pop ends", () => {
    const quick: CaptionLine = {
      start: 1,
      end: 2,
      text: "bir iki",
      changed: false,
      words: [
        { text: "bir", start: 1, end: 1.05 },
        { text: "iki", start: 1.05, end: 2 },
      ],
    };
    const h = captionHtml(doc([quick]), "hap", colors);
    const calls = h.match(/tl\.\w+\("#w0_0 \.c",[^;]*\);/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    // only sets change the chip's opacity, so no running tween can bring it back after the hand-over
    const opacity = calls.filter((c) => c.includes("opacity"));
    expect(opacity.every((c) => c.startsWith("tl.set("))).toBe(true);
    expect(opacity.at(-1)).toBe('tl.set("#w0_0 .c",{opacity:0},1.050);');
  });
});

describe("Karaoke", () => {
  const d = doc([line("bir iki üç", 10, 13)], { durationS: 20 });
  let html = "";
  beforeAll(() => {
    html = captionHtml(d, "karaoke", CAPTION_LOOKS.karaoke.colors);
  });

  it("keeps words dim until they are said, then bright", () => {
    const dim = Number(/\.w\{[^}]*opacity:([\d.]+)/.exec(html)?.[1]);
    expect(dim).toBeLessThan(0.5);
    expect(dim).toBeGreaterThan(0);
    for (const [n, at] of [
      [0, 10],
      [1, 11],
      [2, 12],
    ]) {
      const sets = [
        ...html.matchAll(new RegExp(`tl\\.set\\("#w0_${n}",\\{opacity:1\\},([\\d.]+)\\)`, "g")),
      ];
      expect(sets.map((m) => Number(m[1]))).toEqual([at]);
    }
  });

  it("fills the spoken word with the accent colour as it is said", () => {
    expect(html).toMatch(new RegExp(`\\.f\\{[^}]*color:${CAPTION_LOOKS.karaoke.colors.accent}`));
    expect(html).toMatch(/tl\.fromTo\("#w0_1 \.f",\{width:"0%"\},\{width:"100%"[^}]*\},11\.000\)/);
  });

  it("draws words said before the segment starts bright and filled", () => {
    const long = doc([line("kenarı geçen satır burada", 9, 13)], { durationS: 20 });
    const [, second] = captionSegments(long, 10);
    const h = captionHtml(long, "karaoke", CAPTION_LOOKS.karaoke.colors, second);
    expect(h).toMatch(/<span class="w said" id="w0_0">/);
    expect(h).toMatch(/<span class="w" id="w0_1">/);
    expect(h).toMatch(/\.w\.said\{[^}]*opacity:1/);
  });
});
