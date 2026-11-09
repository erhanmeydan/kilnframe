import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cloneElevenLabsVoice,
  cutVoiceSample,
  ElevenLabsSpeechProvider,
  GeminiSpeechProvider,
  listElevenLabsVoices,
  loadSpeechCatalog,
  narrate,
  pcmWav,
  SpeechError,
  speechChunks,
  speechPriceUsd,
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

  it("hands a single read the text before and after it as context", async () => {
    const seen: { previousText?: string | undefined; nextText?: string | undefined }[] = [];
    const fake: SpeechProvider = {
      id: "fake",
      model: "fake",
      synthesize: async (req) => {
        seen.push({ previousText: req.previousText, nextText: req.nextText });
        return { pcm: tone(1), sampleRate: 24000, audioTokens: 0, inputTokens: 0 };
      },
    };
    const out = join(mkdtempSync(join(tmpdir(), "mi-narr-")), "fix.wav");
    await narrate({
      provider: fake,
      text: "Bir.\n\nİki.",
      voice: "v",
      outFile: out,
      before: "Önce.",
      after: "Sonra.",
    });
    expect(seen).toEqual([
      { previousText: "Önce.", nextText: "İki." },
      { previousText: "Bir.", nextText: "Sonra." },
    ]);
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

describe("ElevenLabs speech", () => {
  function eleven(model: string, handler: (url: string, body: unknown) => Response) {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const provider = new ElevenLabsSpeechProvider({
      apiKey: "test-key",
      model,
      endpoint: "https://example.invalid/",
      fetch: (async (url: string, init: { body: string; headers: Record<string, string> }) => {
        const body = JSON.parse(init.body) as unknown;
        calls.push({ url, body, headers: init.headers });
        return handler(url, body);
      }) as unknown as typeof fetch,
    });
    return { provider, calls };
  }

  it("is in the catalog with prices by the character", () => {
    const entry = loadSpeechCatalog().find((p) => p.id === "elevenlabs");
    expect(entry?.keyName).toBe("elevenlabs");
    expect(entry?.models.map((m) => m.id)).toContain("eleven_v4");
    expect(
      speechPriceUsd("elevenlabs", "eleven_v4", {
        audioTokens: 0,
        inputTokens: 0,
        characters: 1000,
      }),
    ).toBeCloseTo(0.08);
  });

  it("sends the voice id, a style tag, the language and the neighbours, and keeps the PCM", async () => {
    const pcm = tone(0.2);
    const { provider, calls } = eleven("eleven_v4", () => new Response(pcm));
    const r = await provider.synthesize({
      text: "Merhaba.",
      voice: "abc123",
      style: "calm [warm] narrator",
      language: "tr-TR",
      previousText: "Önce.",
    });
    expect(calls[0]?.url).toBe(
      "https://example.invalid/v1/text-to-speech/abc123?output_format=pcm_24000",
    );
    expect(calls[0]?.headers["xi-api-key"]).toBe("test-key");
    expect(calls[0]?.body).toEqual({
      text: "[calm warm narrator] Merhaba.",
      model_id: "eleven_v4",
      language_code: "tr",
      previous_text: "Önce.",
    });
    expect(r.sampleRate).toBe(24000);
    expect(r.pcm.equals(pcm)).toBe(true);
    expect(r.characters).toBe("[calm warm narrator] Merhaba.".length);
  });

  it("leaves the style out for a model that would read the tag aloud", async () => {
    const { provider, calls } = eleven("eleven_flash_v2_5", () => new Response(tone(0.1)));
    await provider.synthesize({ text: "Hi.", voice: "v", style: "calm" });
    expect((calls[0]?.body as { text: string }).text).toBe("Hi.");
  });

  it("explains a refused key and out of credits, and retries a rate limit", async () => {
    const json = (status: number, detail: unknown) =>
      new Response(JSON.stringify({ detail }), { status });
    await expect(
      eleven("eleven_v4", () =>
        json(401, { status: "invalid_api_key", message: "Invalid API key" }),
      ).provider.synthesize({ text: "a", voice: "v" }),
    ).rejects.toThrow(/key was refused/);
    await expect(
      eleven("eleven_v4", () =>
        json(401, { status: "quota_exceeded", message: "No credits" }),
      ).provider.synthesize({ text: "a", voice: "v" }),
    ).rejects.toThrow(/out of credits/);
    await expect(
      eleven("eleven_v4", () =>
        json(401, { status: "missing_permissions", message: "missing text_to_speech" }),
      ).provider.synthesize({ text: "a", voice: "v" }),
    ).rejects.toThrow(/allow Text to Speech, Voices .* and Music Generation/);
    const limited = await eleven("eleven_v4", () =>
      json(429, { status: "too_many_concurrent_requests", message: "busy" }),
    )
      .provider.synthesize({ text: "a", voice: "v" })
      .catch((e: unknown) => e);
    expect(limited).toBeInstanceOf(SpeechError);
    expect((limited as SpeechError).retryable).toBe(true);
    expect((limited as SpeechError).retryAfterS).toBeGreaterThan(0);
  });

  it("lists the account's own voices first, then the default ones", async () => {
    const urls: string[] = [];
    const voices = await listElevenLabsVoices({
      apiKey: "k",
      endpoint: "https://example.invalid",
      fetch: (async (url: string) => {
        urls.push(url);
        const own = url.includes("voice_type=non-default");
        return new Response(
          JSON.stringify({
            voices: own
              ? [{ voice_id: "me1", name: "Erhan", category: "cloned", labels: {} }]
              : [
                  {
                    voice_id: "d1",
                    name: "George - Warm storyteller",
                    category: "premade",
                    labels: { descriptive: "warm", gender: "male", accent: "british" },
                  },
                  { voice_id: "me1", name: "Erhan", category: "cloned" },
                ],
          }),
        );
      }) as unknown as typeof fetch,
    });
    expect(urls).toHaveLength(2);
    expect(voices).toEqual([
      { name: "me1", label: "Erhan", character: "cloned", own: true },
      { name: "d1", label: "George", character: "warm, male, british", own: false },
    ]);
  });
});

describe("voice cloning", () => {
  it("cuts at most three levelled mono minutes out of the range", () => {
    const dir = mkdtempSync(join(tmpdir(), "kf-clone-"));
    const input = join(dir, "range.wav");
    writeFileSync(input, pcmWav(tone(3), 24000));
    const out = cutVoiceSample({ input, startS: 1, endS: 2.5, outFile: join(dir, "sample.wav") });
    expect(out.durationS).toBe(1.5);
    const back = wavPcm(readFileSync(out.file));
    expect(back).toMatchObject({ sampleRate: 44100, channels: 1 });
    expect(back.pcm.length / 2 / 44100).toBeCloseTo(1.5, 1);
    expect(() =>
      cutVoiceSample({ input, startS: 1, endS: 1.2, outFile: join(dir, "x.wav") }),
    ).toThrow(/too short/);
  });

  it("joins several spans into one sample", () => {
    const dir = mkdtempSync(join(tmpdir(), "kf-clone-"));
    const input = join(dir, "range.wav");
    writeFileSync(input, pcmWav(tone(10), 24000));
    const spans = [
      { startS: 1, endS: 2 },
      { startS: 5, endS: 6.5 },
      { startS: 8, endS: 8 },
    ];
    const out = cutVoiceSample({ input, spans, outFile: join(dir, "sample.wav") });
    expect(out.durationS).toBeCloseTo(2.5, 2);
    const back = wavPcm(readFileSync(out.file));
    expect(back).toMatchObject({ sampleRate: 44100, channels: 1 });
    expect(Math.abs(back.pcm.length / 2 / 44100 - 2.5)).toBeLessThan(0.05);
    expect(() =>
      cutVoiceSample({ input, spans: [{ startS: 3, endS: 3 }], outFile: join(dir, "x.wav") }),
    ).toThrow(/too short/);
  });

  it("sends the name and the sample, and returns the new voice", async () => {
    let sent: FormData | undefined;
    let url = "";
    const r = await cloneElevenLabsVoice({
      apiKey: "k",
      endpoint: "https://example.invalid/",
      name: "Benim sesim",
      audio: pcmWav(tone(0.1), 24000),
      removeBackgroundNoise: true,
      fetch: (async (u: string, init: { body: FormData }) => {
        url = u;
        sent = init.body;
        return new Response(JSON.stringify({ voice_id: "new1", requires_verification: false }));
      }) as unknown as typeof fetch,
    });
    expect(url).toBe("https://example.invalid/v1/voices/add");
    expect(sent?.get("name")).toBe("Benim sesim");
    expect(sent?.get("remove_background_noise")).toBe("true");
    expect(sent?.get("files")).toBeInstanceOf(Blob);
    expect(r).toEqual({ voiceId: "new1", requiresVerification: false });
  });
});
