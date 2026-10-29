import { describe, expect, it } from "vitest";
import { correctTranscript } from "../src/captions/correct.js";
import type { CaptionWord } from "../src/captions/types.js";
import type { TextProvider, TextRequest } from "../src/providers/types.js";

function fake(reply: (req: TextRequest, call: number) => string | Error) {
  const requests: TextRequest[] = [];
  const provider: TextProvider = {
    name: "fake",
    model: "fake-model",
    capabilities: { vision: true, structuredOutput: false, contextWindow: 100000 },
    async complete(req) {
      requests.push(req);
      const r = reply(req, requests.length - 1);
      if (r instanceof Error) throw r;
      return { text: r, usage: { inputTokens: 1, outputTokens: 1 }, model: "fake-model" };
    },
  };
  return { provider, requests };
}

function words(texts: string[]): CaptionWord[] {
  return texts.map((text, i) => ({ text, start: i, end: i + 1 }));
}

const userText = (req: TextRequest) => {
  const part = req.messages[0]!.content[0]!;
  return part.type === "text" ? part.text : "";
};

describe("correctTranscript", () => {
  const turkish = words(["yapıcam", "bi", "şey"]);

  it("sends the Turkish rules and the glossary, and aligns the reply to the times", async () => {
    const { provider, requests } = fake(() => "Yapacağım bir şey");
    const r = await correctTranscript({
      provider,
      words: turkish,
      language: "tr",
      glossary: ["TopView", "Kilnframe"],
      mode: "written",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.purpose).toBe("captions-correct");
    expect(requests[0]!.system).toContain("TDK");
    expect(requests[0]!.system).toContain("yapıcam becomes yapacağım");
    expect(requests[0]!.system).toContain("TopView, Kilnframe");
    expect(userText(requests[0]!)).toBe("yapıcam bi şey");
    expect(r.corrected).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.words.map((w) => w.text)).toEqual(["Yapacağım", "bir", "şey"]);
    expect(r.words.map((w) => w.start)).toEqual([0, 1, 2]);
  });

  it("sends no Turkish rules for another language and ignores the mode", async () => {
    const { provider, requests } = fake(() => "Hello there");
    await correctTranscript({
      provider,
      words: words(["hello", "there"]),
      language: "en",
      glossary: [],
      mode: "spoken",
    });
    expect(requests[0]!.system).not.toContain("TDK");
    expect(requests[0]!.system).not.toContain("Turkish");
    expect(requests[0]!.system).not.toContain("as spoken");
  });

  it("tells the model to leave spoken forms as spoken in spoken mode", async () => {
    const { provider, requests } = fake(() => "Yapıcam bi şey");
    await correctTranscript({
      provider,
      words: turkish,
      language: "tr",
      glossary: [],
      mode: "spoken",
    });
    expect(requests[0]!.system).toContain("Leave spoken forms as spoken");
    expect(requests[0]!.system).not.toContain("yapıcam becomes yapacağım");
  });

  it("strips a code fence or quotes around the reply", async () => {
    const fenced = fake(() => "```\nYapacağım bir şey\n```");
    const a = await correctTranscript({
      provider: fenced.provider,
      words: turkish,
      language: "tr",
      glossary: [],
      mode: "written",
    });
    expect(a.words.map((w) => w.text)).toEqual(["Yapacağım", "bir", "şey"]);
    const quoted = fake(() => '"Yapacağım bir şey"');
    const b = await correctTranscript({
      provider: quoted.provider,
      words: turkish,
      language: "tr",
      glossary: [],
      mode: "written",
    });
    expect(b.words.map((w) => w.text)).toEqual(["Yapacağım", "bir", "şey"]);
  });

  it("sends 3,000 words in chunks of at most 800 that end at a sentence end, in order", async () => {
    const all = words(Array.from({ length: 3000 }, (_, i) => (i % 50 === 49 ? `w${i}.` : `w${i}`)));
    const { provider, requests } = fake((req) => userText(req).toUpperCase());
    const r = await correctTranscript({
      provider,
      words: all,
      language: "en",
      glossary: [],
      mode: "written",
    });
    expect(requests.length).toBeGreaterThanOrEqual(4);
    for (const req of requests) {
      const text = userText(req);
      expect(text.split(" ").length).toBeLessThanOrEqual(800);
      expect(text.endsWith(".")).toBe(true);
      expect(req.maxTokens).toBe(4096 + text.split(" ").length * 8);
    }
    expect(r.corrected).toBe(true);
    expect(r.words).toHaveLength(3000);
    expect(r.words.map((w) => w.text)).toEqual(all.map((w) => w.text.toUpperCase()));
    expect(r.words.map((w) => w.start)).toEqual(all.map((w) => w.start));
  }, 60_000);

  it("keeps the original words and reports the error when the provider throws", async () => {
    const { provider } = fake(() => new Error("rate limited"));
    const r = await correctTranscript({
      provider,
      words: turkish,
      language: "tr",
      glossary: [],
      mode: "written",
    });
    expect(r.corrected).toBe(false);
    expect(r.error).toContain("rate limited");
    expect(r.words).toEqual(turkish);
  });

  it("treats a reply with a very different word count as a failure", async () => {
    const { provider } = fake(() => "Bir şey yapacağım ve sonra eve gideceğim herkese selam");
    const r = await correctTranscript({
      provider,
      words: turkish,
      language: "tr",
      glossary: [],
      mode: "written",
    });
    expect(r.corrected).toBe(false);
    expect(r.error).toBeTruthy();
    expect(r.words).toEqual(turkish);
  });

  it("keeps the corrections of good chunks when one chunk fails, and says so", async () => {
    const all = words(
      Array.from({ length: 1000 }, (_, i) => (i % 100 === 99 ? `w${i}.` : `w${i}`)),
    );
    const { provider } = fake((req, call) =>
      call === 1 ? new Error("boom") : userText(req).toUpperCase(),
    );
    const r = await correctTranscript({
      provider,
      words: all,
      language: "en",
      glossary: [],
      mode: "written",
    });
    expect(r.corrected).toBe(true);
    expect(r.error).toContain("1 of 2");
    expect(r.words).toHaveLength(1000);
    expect(r.words[0]!.text).toBe("W0");
    expect(r.words[999]!.text).toBe("w999.");
  });
});
