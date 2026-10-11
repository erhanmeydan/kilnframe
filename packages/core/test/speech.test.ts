import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GeminiSpeechProvider,
  loadSpeechCatalog,
  narrate,
  pcmWav,
  SpeechError,
  speechChunks,
  wavPcm,
  type SpeechProvider,
} from "../src/speech/index.js";
import { storyProblems, wordsPerSecond } from "../src/stages/story.js";

/** A tone of `seconds` at 24 kHz as mono 16-bit PCM. */
function tone(seconds: number, rate = 24000): Buffer {
  const pcm = Buffer.alloc(Math.round(seconds * rate) * 2);
  for (let i = 0; i < pcm.length / 2; i++)
    pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
  return pcm;
}

function geminiProvider(handler: (body: unknown) => Response) {
  const calls: unknown[] = [];
  const provider = new GeminiSpeechProvider({
    apiKey: "test-key",
    model: "gemini-3.8-flash-tts",
    endpoint: "https://example.invalid/interactions",
    audioTokensPerSecond: 25,
    fetch: (async (_url: string, init: { body: string; headers: Record<string, string> }) => {
      calls.push({ body: JSON.parse(init.body), headers: init.headers });
      return handler(JSON.parse(init.body));
    }) as unknown as typeof fetch,
  });
  return { provider, calls };
}

describe("speech", () => {
  it("lists the 30 Gemini voices", () => {
    const gemini = loadSpeechCatalog().find((p) => p.id === "gemini");
    expect(gemini?.voices).toHaveLength(30);
    expect(gemini?.voices.map((v) => v.name)).toContain("Kore");
  });

  it("round trips a mono WAV", () => {
    const pcm = tone(0.1);
    const back = wavPcm(pcmWav(pcm, 24000));
    expect(back).toMatchObject({ sampleRate: 24000, channels: 1 });
    expect(back.pcm.equals(pcm)).toBe(true);
    expect(() => wavPcm(Buffer.from("not a wav"))).toThrow(SpeechError);
  });

  it("splits narration at paragraphs, and long paragraphs at sentence ends", () => {
    expect(speechChunks("Bir.\n\nİki.  \n\n\n Üç.")).toEqual(["Bir.", "İki.", "Üç."]);
    const long = Array.from({ length: 40 }, (_, i) => `Cümle ${i} burada biter.`).join(" ");
    const chunks = speechChunks(long, 200);
    expect(chunks.length).toBeGreaterThan(4);
    expect(chunks.every((c) => c.length <= 200 && c.endsWith("biter."))).toBe(true);
    expect(chunks.join(" ")).toBe(long);
  });

  it("sends Gemini the text, voice and style, and reads the WAV it returns", async () => {
    const wav = pcmWav(tone(0.5), 24000).toString("base64");
    const { provider, calls } = geminiProvider(
      () =>
        new Response(
          JSON.stringify({
            steps: [
              { type: "user_input", content: [{ type: "text", text: "x" }] },
              { type: "model_output", content: [{ type: "audio", data: wav }] },
            ],
          }),
        ),
    );
    const r = await provider.synthesize({ text: "Merhaba", voice: "Kore", style: "calm narrator" });
    expect(r.sampleRate).toBe(24000);
    expect(r.pcm.length).toBe(24000);
    expect(r.audioTokens).toBe(13);
    expect(calls[0]).toMatchObject({
      headers: { "x-goog-api-key": "test-key" },
      body: {
        model: "gemini-3.8-flash-tts",
        input: [
          {
            content: [
              {
                text: "Merhaba",
                annotations: [{ type: "speech_metadata", style: "calm narrator" }],
              },
            ],
          },
        ],
        generation_config: { speech_config: [{ voice: "Kore" }] },
      },
    });
  });

  it("explains a refused key and retries only what can be retried", async () => {
    const refused = geminiProvider(
      () =>
        new Response(JSON.stringify({ error: { message: "API key not valid" } }), { status: 400 }),
    ).provider;
    await expect(refused.synthesize({ text: "a", voice: "Kore" })).rejects.toThrow(
      /key was refused/,
    );
    const busy = geminiProvider(
      () => new Response(JSON.stringify({ error: { message: "quota" } }), { status: 429 }),
    ).provider;
    await expect(busy.synthesize({ text: "a", voice: "Kore" })).rejects.toMatchObject({
      retryable: true,
    });
    // Tier 1's rate limit says how long to wait; narrate waits that long instead of giving up
    const limited = geminiProvider(
      () =>
        new Response(
          JSON.stringify({
            error: { message: "Rate limit exceeded. Please retry in 44s or upgrade." },
          }),
          { status: 429 },
        ),
    ).provider;
    await expect(limited.synthesize({ text: "a", voice: "Kore" })).rejects.toMatchObject({
      retryable: true,
      retryAfterS: 44,
    });
  });

  it("joins the pieces with a pause into a 48 kHz WAV and keeps their times", async () => {
    const fake: SpeechProvider = {
      id: "fake",
      model: "fake",
      synthesize: async () => ({
        pcm: tone(1),
        sampleRate: 24000,
        audioTokens: 25,
        inputTokens: 3,
      }),
    };
    const out = join(mkdtempSync(join(tmpdir(), "mi-narr-")), "narration.wav");
    const r = await narrate({
      provider: fake,
      text: "Birinci paragraf.\n\nİkinci paragraf.",
      voice: "Kore",
      outFile: out,
      pauseS: 0.5,
    });
    expect(r.durationS).toBeCloseTo(2.5, 3);
    expect(r.chunks.map((c) => [c.startS, c.endS])).toEqual([
      [0, 1],
      [1.5, 2.5],
    ]);
    expect(r.audioTokens).toBe(50);
    const written = wavPcm(readFileSync(out));
    expect(written.sampleRate).toBe(48000);
    expect(written.pcm.length / 2 / 48000).toBeCloseTo(2.5, 2);
  });

  it("checks the story's length and dashes", () => {
    expect(wordsPerSecond("tr")).toBe(1.5);
    expect(wordsPerSecond("en")).toBe(2.2);
    const story = { title: "t", voice_style: "calm", paragraphs: ["bir iki üç dört beş"] };
    expect(storyProblems(story, 5)).toEqual([]);
    expect(storyProblems(story, 20).join(" ")).toMatch(/5 words; the target is about 20/);
    expect(storyProblems({ ...story, paragraphs: ["bir — iki üç dört beş"] }, 6).join(" ")).toMatch(
      /dashes/,
    );
  });
});
