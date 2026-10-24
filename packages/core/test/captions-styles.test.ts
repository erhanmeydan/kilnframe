import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toSrt } from "../src/captions/srt.js";
import { CAPTION_LOOKS, captionGrid } from "../src/captions/styles.js";
import { upperCase } from "../src/captions/upper.js";

const vendorFonts = join(import.meta.dirname, "../../../vendor/fonts");

describe("upperCase", () => {
  it("keeps names plain and uses the Turkish rule elsewhere", () => {
    expect(upperCase("TopView'in sorunu", "tr", ["TopView"])).toBe("TOPVIEW'İN SORUNU");
    expect(upperCase("istanbul", "tr", [])).toBe("İSTANBUL");
    expect(upperCase("in time", "en", [])).toBe("IN TIME");
  });
  it("matches a kept name only as a whole word before an apostrophe or punctuation", () => {
    expect(upperCase("aileler", "tr", ["AI"])).toBe("AİLELER");
    expect(upperCase("AI'ın", "tr", ["AI"])).toBe("AI'IN");
  });
  it("folds case with the Turkish locale so a leading İ keeps its length", () => {
    expect(upperCase("İstanbul'un", "tr", ["İstanbul"])).toBe("İSTANBUL'UN");
  });
});

describe("captionGrid", () => {
  it("puts the video look first without repeats", () => {
    const kil = captionGrid("kil-lacivert");
    expect(kil[0]).toBe("kil-lacivert");
    expect(new Set(kil).size).toBe(9);
    const other = captionGrid("beyaz-tahta");
    expect(other[0]).toBe("bant");
    expect(other[7]).toBe("kil-lacivert");
    expect(new Set(other).size).toBe(9);
    expect(captionGrid(null)[0]).toBe("bant");
  });
});

describe("CAPTION_LOOKS", () => {
  it.each(Object.values(CAPTION_LOOKS))("$id fonts exist", (look) => {
    expect(existsSync(join(vendorFonts, look.font))).toBe(true);
    if (look.fontActive) expect(existsSync(join(vendorFonts, look.fontActive))).toBe(true);
  });
  it("gives every look a weight, matching static font files", () => {
    const names: Record<string, number> = { Regular: 400, Medium: 500, SemiBold: 600, Bold: 700 };
    for (const look of Object.values(CAPTION_LOOKS)) {
      expect(look.weight).toBeGreaterThanOrEqual(100);
      expect(look.weight).toBeLessThanOrEqual(900);
      const m = /^poppins\/Poppins-(\w+)\.ttf$/.exec(look.font);
      if (m) expect(names[m[1]]).toBe(look.weight);
    }
  });
  it("keeps Sakin on one line", () => {
    expect(CAPTION_LOOKS.sakin.maxLines).toBe(1);
  });
});

describe("toSrt", () => {
  it("writes cues with comma milliseconds and no trailing blank cue", () => {
    const line = (start: number, end: number, text: string) => ({
      start,
      end,
      text,
      words: [],
      changed: false,
    });
    expect(toSrt([line(0.22, 2.4, "Merhaba"), line(2.5, 3661.007, "dünya")])).toBe(
      "1\n00:00:00,220 --> 00:00:02,400\nMerhaba\n\n2\n00:00:02,500 --> 01:01:01,007\ndünya",
    );
  });
});
