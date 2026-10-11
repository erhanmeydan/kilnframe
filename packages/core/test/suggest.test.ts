import { describe, expect, it } from "vitest";
import {
  listStyles,
  loadStyle,
  styleSummary,
  suggestStyles,
  transcriptDigest,
  type TextProvider,
  type TextRequest,
  type Transcript,
} from "../src/index.js";

const styles = listStyles().map((name) => loadStyle(name));
const transcript: Transcript = {
  version: 1,
  language: "tr",
  model: "test",
  duration_s: 36,
  text: "1955 yılında benim bestem olan Beklenen Şarkı ile Ankara Harp Okulu hareketlerini yaptılar.",
  words: [{ text: "1955", start: 0, end: 0.5 }],
};

function fakeProvider(replies: string[]): TextProvider & { requests: TextRequest[] } {
  const requests: TextRequest[] = [];
  return {
    name: "fake",
    model: "fake-1",
    capabilities: { vision: false, structuredOutput: false, contextWindow: 200_000 },
    requests,
    async complete(req) {
      requests.push(structuredClone(req));
      const text = replies.shift();
      if (text === undefined) throw new Error("no more scripted replies");
      return { text, model: "fake-1", usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
}

describe("style suggestion", () => {
  it("gives every style a proper display name for the panel", () => {
    for (const s of styles) {
      // a name and a description in both panel languages
      expect(s.displayName.en).not.toBe(s.name);
      expect(s.displayName.en).toMatch(/^[A-Z][^-]*$/u);
      expect(s.displayName.tr).toMatch(/^[A-ZÇĞİÖŞÜ][^-]*$/u);
      expect(s.description.en).toMatch(/^[A-Z].+\.$/u);
      expect(s.description.tr).toMatch(/[çğıöşüÇĞİÖŞÜ]/u);
    }
  });

  it("summarises every style from its own style.md, without the stills list", () => {
    for (const s of styles) {
      const summary = styleSummary(s);
      expect(summary.length).toBeGreaterThan(40);
      expect(summary).not.toMatch(/Reference stills|stills\//);
    }
  });

  it("sends short transcripts whole and long ones as excerpts from start to end", () => {
    expect(transcriptDigest("kısa metin")).toBe("kısa metin");
    const long = Array.from({ length: 5000 }, (_, i) => `kelime${i}`).join(" ");
    const digest = transcriptDigest(long, 1200, 4);
    expect(digest.length).toBeLessThan(1300);
    expect(digest).toContain("kelime0");
    expect(digest).toContain("kelime4999");
    expect(digest.split("[...]")).toHaveLength(4);
  });

  it("lists every style for the model and asks again when a name is unknown", async () => {
    const provider = fakeProvider([
      JSON.stringify({ suggestions: [{ style: "nostalji", reason: "eski" }] }),
      JSON.stringify({
        suggestions: [
          { style: "kolaj-halftone", reason: "1955 anısı, eski baskı dokusu" },
          { style: "kagit-kesik", reason: "el yapımı, nostaljik his" },
        ],
      }),
    ]);
    const result = await suggestStyles({ provider, transcript, styles });
    expect(result.suggestions.map((s) => s.style)).toEqual(["kolaj-halftone", "kagit-kesik"]);
    const request = provider.requests[0]?.messages[0]?.content[0];
    const text = request?.type === "text" ? request.text : "";
    for (const s of styles) expect(text).toContain(`- ${s.name}:`);
    const retry = provider.requests[1]?.messages.at(-1)?.content[0];
    expect(retry?.type === "text" && retry.text).toMatch(/"nostalji" is not an available style/);
  });
});
