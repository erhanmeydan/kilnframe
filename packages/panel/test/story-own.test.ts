import { describe, expect, it } from "vitest";
import { OWN_MAX_S, ownParagraphs, ownSummary, ownTitle } from "../src/story-own";

describe("own story text", () => {
  it("keeps the editor's paragraphs as they are", () => {
    expect(ownParagraphs("Bir.\n\nİki.\n\n\nÜç.")).toBe("Bir.\n\nİki.\n\nÜç.");
  });

  it("splits a long text with no blank lines into scenes at sentence ends", () => {
    const sentence = "Kahve Etiyopya'nın dağlarında bulundu ve oradan bütün dünyaya yayıldı.";
    const text = Array.from({ length: 12 }, () => sentence).join(" ");
    const paragraphs = ownParagraphs(text).split("\n\n");
    expect(paragraphs.length).toBeGreaterThan(1);
    for (const p of paragraphs) {
      expect(p.endsWith(".")).toBe(true);
      expect(p.split(/\s+/).length).toBeLessThanOrEqual(60);
    }
    expect(paragraphs.join(" ")).toBe(text);
  });

  it("leaves a short text with no blank lines as one scene", () => {
    expect(ownParagraphs("Kısa bir metin. İki cümle.")).toBe("Kısa bir metin. İki cümle.");
  });

  it("titles the story with its first sentence, kept short", () => {
    expect(ownTitle("Kahvenin yolculuğu. Etiyopya'da başlar.")).toBe("Kahvenin yolculuğu");
    expect(ownTitle("x".repeat(100)).length).toBeLessThanOrEqual(60);
    expect(ownTitle("   ")).toBe("");
  });

  it("counts the words and estimates the narration at the voice's pace", () => {
    const text = Array.from({ length: 150 }, () => "kelime").join(" ");
    expect(ownSummary(text, "tr")).toEqual({ words: 150, seconds: 100, tooLong: false });
    const long = Array.from({ length: 1000 }, () => "kelime").join(" ");
    expect(ownSummary(long, "tr").tooLong).toBe(true);
    expect(OWN_MAX_S).toBe(600);
  });
});
