import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadDefaults } from "../src/config.js";
import {
  closeOcr,
  mergeLines,
  normalizeText,
  ocrScale,
  phraseBox,
  readText,
  tessdataDir,
  type OcrLine,
} from "../src/ocr.js";

const fixture = join(import.meta.dirname, "fixtures", "ui-screenshot.png");
const ocr = loadDefaults().ocr;
const haveData = ocr.languages.every((l) => existsSync(join(tessdataDir(), `${l}.traineddata`)));

afterAll(async () => {
  await closeOcr();
});

const line = (text: string, words: [string, number][]): OcrLine => ({
  id: "l1",
  text,
  confidence: 95,
  box: [0, 0, 500, 30],
  words: words.map(([t, x]) => ({ text: t, box: [x, 10, 60, 20] })),
});

describe("reading text in screenshots", () => {
  it("normalizes Turkish text for matching", () => {
    expect(normalizeText("İSTANBUL’da  Şükrü!")).toBe("istanbul da şükrü");
    expect(normalizeText("29,97 fps")).toBe("29 97 fps");
  });

  it("finds the box of a phrase inside a line", () => {
    const l = line("Kare hızı 29,97 fps", [
      ["Kare", 0],
      ["hızı", 70],
      ["29,97", 300],
      ["fps", 370],
    ]);
    expect(phraseBox(l, "hızı")).toEqual([70, 10, 60, 20]);
    expect(phraseBox(l, "KARE HIZI")).toEqual([0, 10, 130, 20]);
    expect(phraseBox(l, "29 97 fps")).toEqual([300, 10, 130, 20]);
    expect(phraseBox(l)).toEqual([0, 0, 500, 30]);
    expect(phraseBox(l, "kar")).toBeNull();
    expect(phraseBox(l, "çözünürlük")).toBeNull();
  });

  it("keeps the most confident line where passes overlap", () => {
    const merged = mergeLines([
      { text: "Disa Aktar", confidence: 69, box: [10, 10, 100, 20], words: [] },
      { text: "Dışa Aktar", confidence: 96, box: [11, 10, 100, 21], words: [] },
      { text: "Ayarlar", confidence: 90, box: [10, 100, 80, 20], words: [] },
    ]);
    expect(merged.map((l) => `${l.id} ${l.text}`)).toEqual(["l1 Dışa Aktar", "l2 Ayarlar"]);
  });

  it("enlarges small screenshots more", () => {
    expect([ocrScale(1456), ocrScale(1920), ocrScale(2880)]).toEqual([3, 2, 1]);
  });

  it.runIf(haveData)(
    "reads a Retina app screenshot, Turkish letters and button labels included",
    async () => {
      const lines = await readText(fixture, 2880, ocr);
      const texts = lines.map((l) => l.text);
      for (const want of [
        "Kurgu Stüdyosu",
        "+ Yeni Proje",
        "Tanıtım Videosu",
        "Çözünürlük",
        "Şablon",
        "Son değişiklikler",
        "Dışa Aktar",
      ])
        expect(texts).toContain(want);
      // boxes are in the image's own pixels: the export button sits in the bottom right
      const exportLine = lines.find((l) => l.text === "Dışa Aktar") as OcrLine;
      expect(exportLine.box[0]).toBeGreaterThan(2500);
      expect(exportLine.box[1]).toBeGreaterThan(1600);
      const kare = lines.find((l) => l.text.startsWith("Kare hızı")) as OcrLine;
      const box = phraseBox(kare, "hızı") as [number, number, number, number];
      expect(box[0]).toBeGreaterThan(kare.box[0] + 40);
    },
    60_000,
  );
});
