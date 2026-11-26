import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDefaults } from "../src/config.js";
import {
  cloneLocalVoice,
  createSpeechProvider,
  listLocalVoices,
  loadSpeechCatalog,
  localSpeechBaseUrl,
  narrate,
  OpenAICompatibleSpeechProvider,
  pcmWav,
  SpeechError,
  speechPriceUsd,
  speechVoiceFor,
} from "../src/speech/index.js";

/** A tone of `seconds` at `rate` as mono 16-bit PCM. */
function tone(seconds: number, rate = 22050): Buffer {
  const pcm = Buffer.alloc(Math.round(seconds * rate) * 2);
  for (let i = 0; i < pcm.length / 2; i++)
    pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
  return pcm;
}

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** A fake OpenAI-compatible speech server on a free local port. */
async function fakeServer(
  handler: (seen: Seen) => {
    status?: number;
    type?: string;
    body: Buffer | string;
    headers?: Record<string, string>;
  },
): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const s = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      seen.push(s);
      const r = handler(s);
      res.writeHead(r.status ?? 200, { "Content-Type": r.type ?? "audio/wav", ...r.headers });
      res.end(r.body);
    });
  });
  servers.push(server);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, seen };
}

describe("the local voice catalog entry", () => {
  it("is a free provider that needs no key", () => {
    const entry = loadSpeechCatalog().find((p) => p.id === "local");
    expect(entry?.displayName).toBe("Local voice (OpenAI-compatible)");
    expect(entry?.endpoint).toBe("http://127.0.0.1:8890");
    expect(
      speechPriceUsd("local", entry!.models[0]!.id, {
        audioTokens: 0,
        inputTokens: 0,
        characters: 5000,
      }),
    ).toBe(0);
  });

  it("is made without a key, at the catalog's address or the caller's", () => {
    const defaults = loadDefaults();
    const provider = createSpeechProvider(defaults, { provider: "local", model: "m" });
    expect(provider).toBeInstanceOf(OpenAICompatibleSpeechProvider);
    expect(provider.id).toBe("local");
    expect(provider.model).toBe("m");
    expect(() => createSpeechProvider(defaults, { provider: "elevenlabs" })).toThrow(/key/);
  });

  it("reads the address from the caller, then LOCAL_BASE_URL, then the default", () => {
    const old = process.env.LOCAL_BASE_URL;
    try {
      delete process.env.LOCAL_BASE_URL;
      expect(localSpeechBaseUrl()).toBe("http://127.0.0.1:8890");
      process.env.LOCAL_BASE_URL = "http://box:9000/";
      expect(localSpeechBaseUrl()).toBe("http://box:9000");
      expect(localSpeechBaseUrl({ baseUrl: " http://other:1/v1/ " })).toBe("http://other:1");
    } finally {
      if (old === undefined) delete process.env.LOCAL_BASE_URL;
      else process.env.LOCAL_BASE_URL = old;
    }
  });
});

describe("OpenAICompatibleSpeechProvider", () => {
  it("posts the OpenAI speech request and reads the WAV back as PCM", async () => {
    const server = await fakeServer(() => ({ body: pcmWav(tone(0.5), 22050) }));
    const provider = new OpenAICompatibleSpeechProvider({ baseUrl: server.url, model: "tts-1" });
    const out = await provider.synthesize({
      text: "Merhaba dünya.",
      voice: "anna",
      style: " warm\n narrator ",
    });
    expect(server.seen).toHaveLength(1);
    const [seen] = server.seen;
    expect(seen).toMatchObject({ method: "POST", url: "/v1/audio/speech" });
    expect(seen!.headers.authorization).toBeUndefined();
    expect(JSON.parse(seen!.body.toString())).toEqual({
      model: "tts-1",
      input: "Merhaba dünya.",
      voice: "anna",
      response_format: "wav",
      instructions: "warm narrator",
    });
    expect(out.sampleRate).toBe(22050);
    expect(out.pcm.length).toBe(22050);
    expect(out.characters).toBe(14);
  });

  it("sends the bearer token when there is one", async () => {
    const server = await fakeServer(() => ({ body: pcmWav(tone(0.1), 24000) }));
    await new OpenAICompatibleSpeechProvider({
      baseUrl: `${server.url}/`,
      model: "m",
      apiKey: "tok",
    }).synthesize({
      text: "x",
      voice: "v",
    });
    expect(server.seen[0]!.headers.authorization).toBe("Bearer tok");
    expect(JSON.parse(server.seen[0]!.body.toString())).not.toHaveProperty("instructions");
  });

  it("takes raw PCM when asked for it", async () => {
    const pcm = tone(0.25, 24000);
    const server = await fakeServer(() => ({
      type: "audio/pcm",
      body: Buffer.concat([pcm, Buffer.from([1])]),
    }));
    const provider = new OpenAICompatibleSpeechProvider({
      baseUrl: server.url,
      model: "m",
      responseFormat: "pcm",
    });
    const out = await provider.synthesize({ text: "x", voice: "v" });
    expect(JSON.parse(server.seen[0]!.body.toString()).response_format).toBe("pcm");
    expect(out.sampleRate).toBe(24000);
    expect(out.pcm.equals(pcm)).toBe(true);
  });

  it("refuses a stereo WAV and a reply that is not a WAV", async () => {
    const stereo = pcmWav(tone(0.1), 24000);
    stereo.writeUInt16LE(2, 22);
    const bad = await fakeServer(() => ({ body: stereo }));
    await expect(
      new OpenAICompatibleSpeechProvider({ baseUrl: bad.url, model: "m" }).synthesize({
        text: "x",
        voice: "v",
      }),
    ).rejects.toThrow(/not mono/);
    const html = await fakeServer(() => ({ type: "text/html", body: "<html>" }));
    await expect(
      new OpenAICompatibleSpeechProvider({ baseUrl: html.url, model: "m" }).synthesize({
        text: "x",
        voice: "v",
      }),
    ).rejects.toThrow(/did not return a WAV/);
  });

  it("says what the server complained about, and which errors are worth a retry", async () => {
    const run = async (status: number, body: unknown, headers: Record<string, string> = {}) => {
      const server = await fakeServer(() => ({
        status,
        type: "application/json",
        body: JSON.stringify(body),
        headers,
      }));
      return new OpenAICompatibleSpeechProvider({ baseUrl: server.url, model: "m" })
        .synthesize({ text: "x", voice: "v" })
        .then(
          () => null,
          (e: unknown) => e as SpeechError,
        );
    };
    const unknownVoice = await run(404, { error: { message: "no voice nobody" } });
    expect(unknownVoice).toBeInstanceOf(SpeechError);
    expect(unknownVoice!.message).toContain("no voice nobody");
    expect(unknownVoice!.retryable).toBe(false);
    expect((await run(401, { error: "bad" }))!.message).toContain("refused the token");
    expect((await run(503, { detail: "loading" }))!.retryable).toBe(true);
    const limited = await run(429, {}, { "retry-after": "7" });
    expect(limited).toMatchObject({ retryable: true, retryAfterS: 7 });
  });

  it("calls an unreachable server retryable and names its address", async () => {
    const err = await new OpenAICompatibleSpeechProvider({
      baseUrl: "http://127.0.0.1:1",
      model: "m",
    })
      .synthesize({ text: "x", voice: "v" })
      .catch((e: unknown) => e as SpeechError);
    expect(err.message).toContain("http://127.0.0.1:1");
    expect(err.retryable).toBe(true);
  });

  it("narrates a story through narrate(), joining the pieces into a 48 kHz file", async () => {
    const server = await fakeServer(() => ({ body: pcmWav(tone(0.4), 22050) }));
    const provider = new OpenAICompatibleSpeechProvider({ baseUrl: server.url, model: "m" });
    const out = join(mkdtempSync(join(tmpdir(), "kf-local-")), "narration.wav");
    const r = await narrate({
      provider,
      text: "First paragraph.\n\nSecond paragraph.",
      voice: "v",
      outFile: out,
    });
    expect(server.seen).toHaveLength(2);
    expect(r.chunks).toHaveLength(2);
    expect(r.durationS).toBeCloseTo(0.4 + 0.45 + 0.4, 1);
    expect(readFileSync(out).readUInt32LE(24)).toBe(48000);
  });
});

describe("listLocalVoices and cloneLocalVoice", () => {
  it("lists a server's voices in either common shape", async () => {
    const a = await fakeServer(() => ({
      type: "application/json",
      body: JSON.stringify({ data: [{ id: "anna" }, { id: "anna" }, { id: "bob" }] }),
    }));
    expect((await listLocalVoices({ baseUrl: a.url, apiKey: "t" }))!.map((v) => v.name)).toEqual([
      "anna",
      "bob",
    ]);
    expect(a.seen[0]!.headers.authorization).toBe("Bearer t");
    const b = await fakeServer(() => ({
      type: "application/json",
      body: JSON.stringify({ voices: [{ name: "x" }] }),
    }));
    expect((await listLocalVoices({ baseUrl: b.url }))!.map((v) => v.name)).toEqual(["x"]);
  });

  it("answers null when the server has no list", async () => {
    const none = await fakeServer(() => ({ status: 404, type: "application/json", body: "{}" }));
    expect(await listLocalVoices({ baseUrl: none.url })).toBeNull();
  });

  it("uploads the sample as multipart and returns the voice id", async () => {
    const server = await fakeServer(() => ({
      type: "application/json",
      body: JSON.stringify({ id: "my-voice" }),
    }));
    const made = await cloneLocalVoice({
      baseUrl: server.url,
      name: "my voice",
      audio: pcmWav(tone(0.1), 24000),
    });
    expect(made).toEqual({ voiceId: "my-voice" });
    const [seen] = server.seen;
    expect(seen).toMatchObject({ method: "POST", url: "/v1/audio/voices" });
    expect(seen!.headers["content-type"]).toMatch(/^multipart\/form-data/);
    const text = seen!.body.toString("latin1");
    expect(text).toContain('name="name"');
    expect(text).toContain("my voice");
    expect(text).toContain('name="audio_sample"');
    expect(text).toContain("RIFF");
  });

  it("explains a server that cannot clone", async () => {
    const server = await fakeServer(() => ({ status: 404, type: "application/json", body: "{}" }));
    await expect(
      cloneLocalVoice({ baseUrl: server.url, name: "n", audio: Buffer.from("x") }),
    ).rejects.toThrow(/cannot clone/);
  });
});

describe("the voice sent to a provider", () => {
  const defaults = loadDefaults();

  it("is the local provider's own default when none was chosen", () => {
    expect(loadSpeechCatalog().find((p) => p.id === "local")?.defaultVoice).toBe("default");
    expect(speechVoiceFor(defaults, "local")).toBe("default");
    expect(speechVoiceFor(defaults, "local", "  ")).toBe("default");
  });

  it("is the local default when the chosen voice only exists in another provider's catalog", () => {
    expect(defaults.speech.provider).toBe("gemini");
    expect(speechVoiceFor(defaults, "local", defaults.speech.voice)).toBe("default");
    expect(speechVoiceFor(defaults, "local", "Puck")).toBe("default");
  });

  it("keeps a voice the provider can own, and the defaults' voice for the defaults' provider", () => {
    expect(speechVoiceFor(defaults, "local", "my-clone")).toBe("my-clone");
    expect(speechVoiceFor(defaults, "local", "alloy")).toBe("alloy");
    expect(speechVoiceFor(defaults, "local", "default")).toBe("default");
    expect(speechVoiceFor(defaults, "gemini")).toBe(defaults.speech.voice);
    expect(speechVoiceFor(defaults, "gemini", "Puck")).toBe("Puck");
    // an ElevenLabs voice id is nobody's catalog entry: it is kept
    expect(speechVoiceFor(defaults, "elevenlabs", "21m00Tcm4TlvDq8ikWAM")).toBe(
      "21m00Tcm4TlvDq8ikWAM",
    );
  });
});

const cli = join(import.meta.dirname, "..", "dist", "cli.js");

describe.skipIf(!existsSync(cli))("kilnframe story --speech-provider local (built CLI)", () => {
  async function story(extra: string[]) {
    const server = await fakeServer(() => ({ body: pcmWav(tone(0.3), 22050) }));
    const dir = mkdtempSync(join(tmpdir(), "kf-cli-"));
    const script = join(dir, "s.txt");
    writeFileSync(script, "Merhaba dünya.");
    const child = spawn(
      process.execPath,
      [
        cli,
        "story",
        "--script",
        script,
        "--out",
        join(dir, "o"),
        "--language",
        "tr",
        "--speech-provider",
        "local",
        ...extra,
      ],
      { env: { ...process.env, LOCAL_BASE_URL: server.url, KILNFRAME_HOME: dir }, stdio: "ignore" },
    );
    const code = await new Promise<number | null>((done) => child.on("exit", done));
    return { code, seen: server.seen, out: join(dir, "o") };
  }

  it("sends the local default voice, not the Gemini default, when no --voice is given", async () => {
    const r = await story([]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.seen[0]!.body.toString()).voice).toBe("default");
    expect(existsSync(join(r.out, "narration.wav"))).toBe(true);
  }, 30_000);

  it("sends the voice that was asked for", async () => {
    const r = await story(["--voice", "anna"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.seen[0]!.body.toString()).voice).toBe("anna");
  }, 30_000);
});
