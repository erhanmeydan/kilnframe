import { copyFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
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
const LOOKS: CaptionStyleId[] = [
  "kil-lacivert",
  "loud",
  "dinamik",
  "hap",
  "karaoke",
  "daktilo",
  "sakin",
  "bant",
  "editoryal",
];

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

  it("sets every word in a font of the user's own when given one, with the format its kind needs", () => {
    // another look's font, copied as an OpenType file, so the copy shows the given file was read
    const src = join(vendorFonts, CAPTION_LOOKS.loud.font);
    const own = join(mkdtempSync(join(tmpdir(), "kf-own-font-")), "Own Font.otf");
    copyFileSync(src, own);
    const dir = mkdtempSync(join(tmpdir(), "kf-caption-project-"));
    buildCaptionProject(sample, "editoryal", CAPTION_LOOKS.editoryal.colors, dir, undefined, own);
    const html = readFileSync(join(dir, "index.html"), "utf8");
    expect(readFileSync(join(dir, "font.otf"))).toEqual(readFileSync(src));
    expect(existsSync(join(dir, "font.ttf"))).toBe(false);
    // the look's italic for the active word gives way to the user's font
    expect(existsSync(join(dir, "font-active.ttf"))).toBe(false);
    expect(html.match(/src:url\("font\.otf"\) format\("opentype"\)/g)).toHaveLength(2);
    expect(CAPTION_LOOKS.editoryal.font).not.toBe(own);
  });
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
      if (look !== "bant" && look !== "sakin") expect(html).toContain('"#w0_1');
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

describe("Daktilo", () => {
  /** Times at which the letters of word n of line 0 are shown, in order. */
  function letterTimes(html: string, n: number): number[] {
    return [
      ...html.matchAll(new RegExp(`tl\\.set\\("#w0_${n}c\\d+",\\{opacity:1\\},([\\d.]+)\\)`, "g")),
    ].map((m) => Number(m[1]));
  }

  it("types each word letter by letter and shows the whole word by the word's end", () => {
    const d = doc([line("referans yok.", 10, 12)], { durationS: 20 });
    const html = captionHtml(d, "daktilo", CAPTION_LOOKS.daktilo.colors);
    expect(html).toMatch(/\.ch\{[^}]*opacity:0[;}]/);
    for (const [n, word, start, end] of [
      [0, "referans", 10, 11],
      [1, "yok.", 11, 12],
    ] as const) {
      const times = letterTimes(html, n);
      expect(times).toHaveLength([...word].length);
      expect(times[0]).toBe(start);
      // letter by letter: each comes after the one before
      times.forEach((at, j) => j && expect(at).toBeGreaterThan(times[j - 1] as number));
      expect(Math.max(...times)).toBeLessThanOrEqual(end);
    }
  });

  it("finishes a short word by its end", () => {
    const quick: CaptionLine = {
      start: 1,
      end: 2,
      text: "kullanmayacağım. o",
      changed: false,
      words: [
        { text: "kullanmayacağım.", start: 1, end: 1.12 },
        { text: "o", start: 1.12, end: 2 },
      ],
    };
    const html = captionHtml(doc([quick]), "daktilo", CAPTION_LOOKS.daktilo.colors);
    const times = letterTimes(html, 0);
    expect(times).toHaveLength(16);
    expect(Math.max(...times)).toBeLessThanOrEqual(1.12);
  });

  it("draws the letters of a word said before the segment starts already typed", () => {
    const long = doc([line("kenarı geçen satır burada", 9, 13)], { durationS: 20 });
    const [, second] = captionSegments(long, 10);
    const html = captionHtml(long, "daktilo", CAPTION_LOOKS.daktilo.colors, second);
    expect(html).toMatch(/<span class="ch on" id="w0_0c0">k/);
    expect(html).toMatch(/\.ch\.on\{[^}]*opacity:1/);
  });
});

describe("Sakin", () => {
  const d = doc(
    [line("Işık İstanbul'da TopView'in ÇOK güzel ve uzun bir cümlesi var gerçekten", 1, 6)],
    { glossary: ["TopView"] },
  );
  let html = "";
  beforeAll(() => {
    html = captionHtml(d, "sakin", CAPTION_LOOKS.sakin.colors);
  });

  it("keeps a long line on one row", () => {
    expect(html.match(/class="row"/g)).toHaveLength(1);
  });

  it("writes lower case with the language's rule and keeps glossary names", () => {
    expect(html).toContain("ışık");
    expect(html).toContain("istanbul'da");
    expect(html).toContain("TopView'in");
    expect(html).toContain("çok");
    const en = captionHtml(
      doc([line("I SAW TopView In Istanbul", 1, 3)], { language: "en", glossary: ["TopView"] }),
      "sakin",
      CAPTION_LOOKS.sakin.colors,
    );
    const row = /<div class="row">(.*?)<\/div>/.exec(en)?.[1]?.replace(/<[^>]+>/g, "");
    expect(row).toBe("i saw TopView in istanbul");
  });

  it("animates nothing but the line's appearance", () => {
    const calls = html.match(/tl\.(?:to|from|fromTo)\([^;]*\);/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^tl\.fromTo\("#l0 \.block",\{opacity:0\}/);
    const sets = html.match(/tl\.set\("([^"]*)"/g) ?? [];
    expect(sets.every((s) => /^tl\.set\("#l\d+"$/.test(s))).toBe(true);
  });
});

describe("Editoryal", () => {
  const d = doc([line("bir iki üç", 10, 13)], { durationS: 20 });
  let html = "";
  beforeAll(() => {
    html = captionHtml(d, "editoryal", CAPTION_LOOKS.editoryal.colors);
  });

  it("draws the spoken word in the italic face and the accent colour", () => {
    expect(html).toMatch(/@font-face\{font-family:"CaptionActive";src:url\("font-active\.ttf"\)/);
    expect(html).toMatch(
      new RegExp(
        `\\.i\\{[^}]*font-family:CaptionActive[^}]*color:${CAPTION_LOOKS.editoryal.colors.accent}`,
      ),
    );
    expect(html).toMatch(/<span class="i" aria-hidden="true">iki<\/span>/);
    expect(html).toMatch(/tl\.fromTo\("#w0_1 \.i",\{opacity:0\},\{opacity:1[^}]*\},11\.000\)/);
    expect(html).toContain('tl.set("#w0_1 .r",{opacity:0},11.000)');
  });

  it("hands the italic over to the next word as it starts and keeps the last one", () => {
    expect(html).toContain('tl.set("#w0_0 .i",{opacity:0},11.000)');
    expect(html).toMatch(/tl\.to\("#w0_0 \.r",\{opacity:1[^}]*\},11\.000\)/);
    expect(html).not.toContain('tl.set("#w0_2 .i",{opacity:0}');
    // the roman form is never sent to a hidden from-state ahead of its word
    expect(html).not.toMatch(/tl\.fromTo\("#w0_\d \.r"/);
  });

  it("copies the italic font next to index.html", () => {
    const dir = mkdtempSync(join(tmpdir(), "kf-caption-editoryal-"));
    buildCaptionProject(d, "editoryal", CAPTION_LOOKS.editoryal.colors, dir);
    expect(readFileSync(join(dir, "font-active.ttf"))).toEqual(
      readFileSync(join(vendorFonts, CAPTION_LOOKS.editoryal.fontActive as string)),
    );
  });
});

describe("word colour, emphasis and line emoji", () => {
  /** The scale rule for word n of line 0; whole: the only extra rule. */
  const scaleRule = (n: number, whole = false) =>
    new RegExp(
      `${whole ? "^" : ""}#w0_${n}\\{display:inline-block;scale:1\\.15;margin:0 [\\d.]+em\\}${whole ? "$" : ""}`,
    );
  const extras = (html: string) => {
    const blocks = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1] as string);
    return blocks.length > 1 ? (blocks.slice(1).join("\n").trim() as string) : "";
  };
  const withWord = (
    n: number,
    over: Partial<CaptionLine["words"][number]>,
    over2: Partial<CaptionLine> = {},
  ) => {
    const l = line("bir iki üç dört", 1, 3);
    l.words[n] = { ...(l.words[n] as CaptionLine["words"][number]), ...over };
    return doc([{ ...l, ...over2 }]);
  };

  it("adds nothing when no word has a colour or emphasis and no line has an emoji", () => {
    for (const look of LOOKS) {
      const html = captionHtml(sample, look, CAPTION_LOOKS[look].colors);
      expect(html.match(/<style>/g)).toHaveLength(1);
      expect(html).not.toContain("has-emoji");
      expect(html).not.toContain(".emoji");
    }
  });

  it("draws a word in its own #rrggbb colour with exactly one rule", () => {
    const html = captionHtml(
      withWord(1, { color: "#ff0000" }),
      "sakin",
      CAPTION_LOOKS.sakin.colors,
    );
    expect(html.match(/#w0_1\{color:#ff0000\}/g)).toHaveLength(1);
    expect(extras(html)).toBe("#w0_1{color:#ff0000}");
  });

  it("ignores a colour that is not #rrggbb", () => {
    for (const color of ["red;}body{", "#fff", "#12345g", "#ff0000;x"]) {
      const html = captionHtml(withWord(1, { color }), "sakin", CAPTION_LOOKS.sakin.colors);
      expect(html.match(/<style>/g)).toHaveLength(1);
      expect(html).not.toContain("#w0_1{");
      expect(html).not.toContain("body{color");
    }
  });

  it("draws an emphasised word in the accent colour in Loud (colour mode)", () => {
    const html = captionHtml(withWord(2, { emphasis: true }), "loud", CAPTION_LOOKS.loud.colors);
    expect(extras(html)).toBe(`#w0_2{color:${CAPTION_LOOKS.loud.colors.accent}}`);
    expect(html).not.toContain("scale:1.15");
  });

  it.each(["dinamik", "daktilo", "hap", "karaoke"] as const)(
    "falls back to scale in %s, where the accent colour cannot show",
    (look) => {
      const html = captionHtml(withWord(2, { emphasis: true }), look, CAPTION_LOOKS[look].colors);
      expect(extras(html)).toMatch(scaleRule(2, true));
    },
  );

  it("treats accent and text that differ only in case as the same colour", () => {
    const html = captionHtml(withWord(0, { emphasis: true }), "loud", {
      text: "#FFFFFF",
      accent: "#ffffff",
    });
    expect(extras(html)).toMatch(scaleRule(0, true));
  });

  it("treats an accent too near the text colour to tell apart as the same colour", () => {
    const html = captionHtml(withWord(0, { emphasis: true }), "loud", {
      text: "#ffd040",
      accent: "#ffd23f",
    });
    expect(extras(html)).toMatch(scaleRule(0, true));
  });

  it.each(["#ffd23f", "#FFD23F", "#ffcc40"])(
    "scales an emphasised word whose own colour (%s) is the accent or near it, and colours the rest",
    (color) => {
      const l = line("bir iki üç", 1, 3);
      const ws = l.words as CaptionLine["words"][number][];
      ws[0] = { ...(ws[0] as CaptionLine["words"][number]), emphasis: true, color };
      ws[2] = { ...(ws[2] as CaptionLine["words"][number]), emphasis: true };
      const css = extras(captionHtml(doc([l]), "loud", CAPTION_LOOKS.loud.colors));
      // the word keeps its own colour and is drawn larger, as it would be where the accent equals the text
      expect(css).toContain(`#w0_0{color:${color}}`);
      expect(css).toMatch(scaleRule(0));
      // a word not near the accent is coloured, not scaled
      expect(css).toContain(`#w0_2{color:${CAPTION_LOOKS.loud.colors.accent}}`);
      expect(css).not.toMatch(scaleRule(2));
    },
  );

  it("draws both in both mode where colour shows, and only scale where it does not", () => {
    const d = { ...withWord(1, { emphasis: true }), emphasis: "both" as const };
    const loud = extras(captionHtml(d, "loud", CAPTION_LOOKS.loud.colors));
    expect(loud).toContain(`#w0_1{color:${CAPTION_LOOKS.loud.colors.accent}}`);
    expect(loud).toMatch(scaleRule(1));
    const hap = extras(captionHtml(d, "hap", CAPTION_LOOKS.hap.colors));
    expect(hap).toMatch(scaleRule(1, true));
    // Karaoke sweeps the accent over the spoken word: a word already in the accent would hide the sweep
    const karaoke = extras(captionHtml(d, "karaoke", CAPTION_LOOKS.karaoke.colors));
    expect(karaoke).toMatch(scaleRule(1, true));
    expect(karaoke).not.toContain(CAPTION_LOOKS.karaoke.colors.accent);
  });

  it("scales without colour in scale mode, and the emphasis colour wins over the word's own", () => {
    const scale = {
      ...withWord(1, { emphasis: true, color: "#00ff00" }),
      emphasis: "scale" as const,
    };
    const html = extras(captionHtml(scale, "loud", CAPTION_LOOKS.loud.colors));
    expect(html).toContain("#w0_1{color:#00ff00}");
    expect(html).toMatch(scaleRule(1));
    const colour = extras(
      captionHtml(
        withWord(1, { emphasis: true, color: "#00ff00" }),
        "loud",
        CAPTION_LOOKS.loud.colors,
      ),
    );
    expect(colour).toBe(`#w0_1{color:${CAPTION_LOOKS.loud.colors.accent}}`);
  });

  it("restores Loud's popped word to its own colour, not the text colour", () => {
    const html = captionHtml(withWord(1, { color: "#00ff00" }), "loud", CAPTION_LOOKS.loud.colors);
    const { text } = CAPTION_LOOKS.loud.colors;
    expect(html).toMatch(/tl\.set\("#w0_1",\{color:"#00ff00"\},[\d.]+\);\n/);
    expect(html).not.toMatch(new RegExp(`tl\\.set\\("#w0_1",\\{color:"${text}"\\}`));
    expect(html).toMatch(new RegExp(`tl\\.set\\("#w0_0",\\{color:"${text}"\\},[\\d.]+\\);\\n`));
    // an emphasised word in colour mode goes back to the accent
    const emph = captionHtml(withWord(1, { emphasis: true }), "loud", CAPTION_LOOKS.loud.colors);
    expect(emph).toMatch(
      new RegExp(
        `tl\\.set\\("#w0_1",\\{color:"${CAPTION_LOOKS.loud.colors.accent}"\\},[\\d.]+\\);\\n`,
      ),
    );
  });

  it("draws an emoji above the line, escaped, and pops it in with the line", () => {
    const d = doc([{ ...line("bir iki üç", 2, 4), emoji: "<b>🔥" }, line("dört beş", 5, 6)]);
    for (const portrait of [true, false]) {
      const html = captionHtml(
        portrait ? d : { ...d, width: 1920, height: 1080 },
        "loud",
        CAPTION_LOOKS.loud.colors,
      );
      const size = Number(/class="block" style="font-size:([\d.]+)px"/.exec(html)?.[1]);
      expect(html).toContain(
        `<div class="line has-emoji" id="l0"><div class="emoji-box"><div class="emoji" style="font-size:${Math.round(size * 11) / 10}px">&lt;b&gt;🔥</div><div class="block" style="font-size:${size}px">`,
      );
      expect(html).not.toContain("<b>");
      expect(html).toContain('<div class="line" id="l1">');
      const css = extras(html);
      expect(css).toContain(".emoji-box{position:relative}");
      expect(css).toContain(
        '.emoji{position:absolute;left:0;right:0;bottom:100%;display:flex;justify-content:center;white-space:nowrap;font-family:"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji";line-height:1;margin-bottom:.15em}',
      );
      expect(html).toContain(
        'tl.fromTo("#l0 .emoji",{opacity:0,scale:0.6},{opacity:1,scale:1,duration:0.18,ease:"back.out(2)"},2.000);',
      );
      expect(html).not.toContain('"#l1 .emoji"');
    }
  });

  it.each([
    [1080, 1920],
    [1920, 1080],
  ])("keeps a line with an emoji exactly where it sits without one (%ix%i)", (width, height) => {
    const plain = doc([line("bir iki üç", 2, 4)], { width, height });
    const withEmoji = doc([{ ...line("bir iki üç", 2, 4), emoji: "🔥" }], { width, height });
    const a = captionHtml(plain, "loud", CAPTION_LOOKS.loud.colors);
    const b = captionHtml(withEmoji, "loud", CAPTION_LOOKS.loud.colors);
    // the page's own styles, the block and its size are the same
    const firstStyle = (h: string) => /<style>[\s\S]*?<\/style>/.exec(h)?.[0];
    expect(firstStyle(b)).toBe(firstStyle(a));
    const block = (h: string) => /<div class="block"[^>]*>.*?<\/div><\/div>/.exec(h)?.[0];
    expect(block(b)).toBe(block(a));
    // the only box around the block is a positioned one with nothing else set, and nothing restyles the line
    const css = extras(b);
    expect(css).not.toMatch(/\.line|\.block/);
    expect(css).toMatch(/^\.emoji-box\{position:relative\}$/m);
    // the emoji is out of the flow, hung above the box
    expect(css).toMatch(/^\.emoji\{position:absolute;left:0;right:0;bottom:100%;/m);
    // without the emoji and its box the line's markup is the plain line's
    const unwrapped = b
      .replace(/<div class="emoji-box"><div class="emoji"[^>]*>[^<]*<\/div>/, "")
      .replace(/<\/div><\/div><\/div>\n<\/div>/, "</div></div>\n</div>")
      .replace(' has-emoji"', '"');
    const lineOf = (h: string) => /<div class="line"[^\n]*/.exec(h)?.[0];
    expect(lineOf(unwrapped)).toBe(lineOf(a));
  });

  it("leaves the emoji pop out for a line that came in before the segment", () => {
    const d = doc([{ ...line("kenarı geçen satır burada", 9, 13), emoji: "🎉" }], {
      durationS: 20,
    });
    const [first, second] = captionSegments(d, 10);
    expect(captionHtml(d, "loud", CAPTION_LOOKS.loud.colors, first)).toContain(
      'tl.fromTo("#l0 .emoji"',
    );
    const html = captionHtml(d, "loud", CAPTION_LOOKS.loud.colors, second);
    expect(html).toContain('class="line has-emoji"');
    expect(html).not.toContain('"#l0 .emoji"');
  });

  it("measures a scaled word's growth into the row, so the block is drawn smaller when it would not fit", () => {
    // a row that just fits without emphasis
    const words = "AAAAAA BBBBBB CCCCCC DDDDDD EEEEEE FFFFFF GGG";
    const plain = doc([line(words, 1, 4)]);
    const base = fontSizes(captionHtml(plain, "sakin", CAPTION_LOOKS.sakin.colors))[0] as number;
    const l = line(words, 1, 4);
    l.words = l.words.map((w) => ({ ...w, emphasis: true }));
    const scaled = fontSizes(
      captionHtml({ ...doc([l]), emphasis: "scale" }, "sakin", CAPTION_LOOKS.sakin.colors),
    )[0] as number;
    expect(scaled).toBeLessThan(base);
  });

  it("gives a scaled word margins that hold its growth, so its neighbours move aside", () => {
    for (const look of ["kil-lacivert", "bant", "karaoke", "dinamik", "hap"] as const) {
      const f = fontkit.openSync(join(vendorFonts, CAPTION_LOOKS[look].font)) as fontkit.Font;
      const font =
        "wght" in (f.variationAxes ?? {})
          ? f.getVariation({ wght: CAPTION_LOOKS[look].weight })
          : f;
      const word = "gerçekleştirdik";
      const measured =
        font.layout(word).positions.reduce((a, p) => a + p.xAdvance, 0) / font.unitsPerEm;
      const l = line(`bunu ${word} sonunda`, 1, 3);
      l.words[1] = { ...(l.words[1] as CaptionLine["words"][number]), emphasis: true };
      const html = captionHtml(
        { ...doc([l]), emphasis: "scale" },
        look,
        CAPTION_LOOKS[look].colors,
      );
      const margin = Number(
        /#w0_1\{display:inline-block;scale:1\.15;margin:0 ([\d.]+)em\}/.exec(html)?.[1],
      );
      // half its growth (letter spacing aside) plus 0.08 em
      // as drawn: with the look's letter spacing
      const ls = Number(/letter-spacing:(-?[\d.]+)em/.exec(html)?.[1]);
      const drawn = measured + ls * [...word].length;
      // half its growth, plus 0.08 em
      expect(margin).toBeGreaterThanOrEqual(0.075 * drawn + 0.08 - 0.001);
    }
  });

  it("draws a coloured word in Hap in the text colour while it is on the chip", () => {
    const l = line("bir iki üç", 10, 13);
    l.words[1] = { ...(l.words[1] as CaptionLine["words"][number]), color: "#00ff00" };
    const html = captionHtml(doc([l], { durationS: 20 }), "hap", CAPTION_LOOKS.hap.colors);
    expect(html).toContain(`tl.set("#w0_1",{color:"${CAPTION_LOOKS.hap.colors.text}"},11.000);`);
    expect(html).toContain('tl.set("#w0_1",{color:"#00ff00"},12.000);');
    // an uncoloured word is left alone
    expect(html).not.toMatch(/tl\.set\("#w0_[02]",\{color/);
  });

  it("starts Hap's chip slide into a scaled word from where the chip before is seen", () => {
    const plain = doc([line("bir iki üç", 10, 13)], { durationS: 20 });
    const l = line("bir iki üç", 10, 13);
    l.words[1] = { ...(l.words[1] as CaptionLine["words"][number]), emphasis: true };
    const from = (html: string) =>
      /tl\.fromTo\("#w0_1 \.c",\{left:"(-?[\d.]+)em",width:"([\d.]+)em"\}/
        .exec(html)!
        .slice(1)
        .map(Number);
    const [, widthPlain] = from(captionHtml(plain, "hap", CAPTION_LOOKS.hap.colors));
    const [leftScaled, widthScaled] = from(
      captionHtml(doc([l], { durationS: 20 }), "hap", CAPTION_LOOKS.hap.colors),
    );
    // the chip before is not scaled; in the scaled word's space it is 1.15 times smaller
    expect(widthScaled).toBeCloseTo((widthPlain as number) / 1.15, 2);
    expect(leftScaled).toBeLessThan(0);
  });

  it.each([
    // the accent sweeps a word of another colour
    ["#00ff00", "accent"],
    ["#ffffff", "accent"],
    // a word in the accent, or near it, is swept in the text colour
    ["#7be0ff", "text"],
    ["#80e0f8", "text"],
  ] as const)(
    "keeps Karaoke's sweep visible over a word coloured %s (swept in the %s colour)",
    (color, swept) => {
      const { text, accent } = CAPTION_LOOKS.karaoke.colors;
      const html = captionHtml(withWord(1, { color }), "karaoke", CAPTION_LOOKS.karaoke.colors);
      const css = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
      // the colour the last rule for this selector gives, as the page would draw it
      const last = (selector: RegExp) => [...css.matchAll(selector)].at(-1)?.[1];
      const word = last(/#w0_1\{color:(#[0-9a-f]{6})\}/gi) ?? text;
      const sweep =
        last(/#w0_1 \.f\{color:(#[0-9a-f]{6})\}/gi) ?? last(/^\.f\{[^}]*color:(#[0-9a-f]{6})/gim);
      expect(word).toBe(color);
      // the said part must read apart from the part not said yet: far apart in RGB
      const rgb = (h: string) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
      const apart = Math.hypot(...rgb(word).map((v, k) => v - (rgb(sweep as string)[k] as number)));
      expect(apart).toBeGreaterThan(100);
      expect(sweep).toBe(swept === "accent" ? accent : text);
    },
  );

  it("keeps Daktilo's strip from running ahead of the caret before a scaled word", () => {
    const words = (emph: boolean) => {
      const l = line("bir harika", 10, 12);
      if (emph) l.words[1] = { ...(l.words[1] as CaptionLine["words"][number]), emphasis: true };
      return captionHtml(doc([l], { durationS: 20 }), "daktilo", CAPTION_LOOKS.daktilo.colors);
    };
    // the strip's cut once "bir" is typed (its last letter)
    const cut = (html: string) =>
      Number(
        /tl\.set\("#w0_0c2",\{opacity:1\},[\d.]+\);tl\.set\("#w0_0c2 i",\{opacity:1\},[\d.]+\);tl\.set\("[^"]+",\{clipPath:"inset\(0em ([\d.]+)em/.exec(
          html,
        )?.[1],
      );
    const scaled = words(true);
    const margin = Number(/margin:0 ([\d.]+)em/.exec(scaled)?.[1]);
    expect(cut(scaled) - cut(words(false))).toBeCloseTo(2 * margin, 2);
  });

  it.each([
    ["bant", 8],
    ["karaoke", 8],
    ["hap", 10],
    ["kil-lacivert", 10],
  ] as const)("raises %s's emoji with its block as it comes in", (look, y) => {
    const d = doc([{ ...line("bir iki üç", 2, 4), emoji: "🔥" }]);
    const html = captionHtml(d, look, CAPTION_LOOKS[look].colors);
    expect(html).toMatch(new RegExp(`tl\\.fromTo\\("#l0 \\.block",\\{opacity:0,y:${y}\\}`));
    expect(html).toContain(
      `tl.fromTo("#l0 .emoji",{opacity:0,scale:0.6,y:${y}},{opacity:1,scale:1,y:0,duration:0.18,ease:"back.out(2)"},2.000);`,
    );
  });

  it("fades Bant's emoji out with its block", () => {
    const html = captionHtml(
      doc([{ ...line("bir iki üç", 2, 4), emoji: "🔥" }]),
      "bant",
      CAPTION_LOOKS.bant.colors,
    );
    expect(html).toMatch(/tl\.to\("#l0 \.block,#l0 \.emoji",\{opacity:0/);
    const plain = captionHtml(doc([line("bir iki üç", 2, 4)]), "bant", CAPTION_LOOKS.bant.colors);
    expect(plain).toMatch(/tl\.to\("#l0 \.block",\{opacity:0/);
  });

  it("takes only #rrggbb colours, a true emphasis and a short emoji without control characters", () => {
    const rgba = captionHtml(withWord(1, { emphasis: true }), "loud", {
      text: "#ffffff",
      accent: "rgba(1,2,3,1)",
    });
    expect(rgba.match(/<style>/g)).toHaveLength(1);
    const stringy = captionHtml(
      withWord(1, { emphasis: "false" as unknown as boolean }),
      "loud",
      CAPTION_LOOKS.loud.colors,
    );
    expect(stringy.match(/<style>/g)).toHaveLength(1);
    for (const emoji of ["🔥".repeat(9), "a\u0007", "x\ny"]) {
      const html = captionHtml(
        doc([{ ...line("bir iki", 1, 2), emoji }]),
        "bant",
        CAPTION_LOOKS.bant.colors,
      );
      expect(html).not.toContain("emoji");
    }
  });
});
