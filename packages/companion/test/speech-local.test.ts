import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pcmWav, wavPcm } from "@kilnframe/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeCloneVoice } from "../src/clone-voice.js";
import { ClientMessageSchema, JobParamsSchema, MemoryKeyStore } from "../src/index.js";
import { pipelineRunner } from "../src/runner.js";

const events = { progress: () => {}, signal: new AbortController().signal };
const dir = () => mkdtempSync(join(tmpdir(), "kf-local-"));

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** A fake speech server: every request is kept, speech answers a one-second WAV. */
async function fakeSpeechServer() {
  const requests: { url: string; auth?: string | undefined; body: string }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      requests.push({
        url: req.url ?? "",
        auth: req.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (req.url === "/v1/audio/speech") {
        res.writeHead(200, { "Content-Type": "audio/wav" });
        res.end(pcmWav(Buffer.alloc(22050 * 2), 22050));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  servers.push(server);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests };
}

describe("local speech in the companion protocol", () => {
  it("accepts the local provider and an address, and refuses a bad address", () => {
    const ok = (m: unknown) => ClientMessageSchema.safeParse(m).success;
    expect(ok({ type: "speech.voices", provider: "local", baseURL: "http://127.0.0.1:8890" })).toBe(
      true,
    );
    expect(ok({ type: "speech.voices", provider: "local", baseURL: "not a url" })).toBe(false);
    expect(ok({ type: "speech.preview", voice: "anna", language: "tr", provider: "local" })).toBe(
      true,
    );
    expect(
      ok({
        type: "speech.clone",
        provider: "local",
        audioPath: "/a.wav",
        rangeStartS: 0,
        rangeEndS: 5,
        name: "n",
        consent: true,
      }),
    ).toBe(true);
    expect(
      ok({
        type: "speech.clone",
        provider: "local",
        audioPath: "/a.wav",
        rangeStartS: 0,
        rangeEndS: 5,
        name: "n",
      }),
    ).toBe(false);
    expect(
      JobParamsSchema.safeParse({
        kind: "voice-fix-say",
        text: "x",
        voice: "v",
        outDir: "/a",
        take: 1,
        speechProvider: "local",
      }).success,
    ).toBe(true);
  });
});

describe("local speech jobs", () => {
  it("reads a story through the local server, with no key and the panel's address", async () => {
    const server = await fakeSpeechServer();
    const outDir = dir();
    const r = (await pipelineRunner(new MemoryKeyStore())(
      JobParamsSchema.parse({
        kind: "story-voice",
        text: "Bir hikaye.\n\nİkinci bölüm.",
        voice: "anna",
        outDir,
        speechProvider: "local",
        speechBaseURL: server.url,
        language: "tr",
      }),
      events,
    )) as { provider?: string; listPriceUsd?: number };
    expect(server.requests.map((q) => q.url)).toEqual(["/v1/audio/speech", "/v1/audio/speech"]);
    expect(server.requests[0]!.auth).toBeUndefined();
    expect(JSON.parse(server.requests[0]!.body)).toMatchObject({
      voice: "anna",
      input: "Bir hikaye.",
      response_format: "wav",
    });
    expect(readFileSync(join(outDir, "story.txt"), "utf8")).toContain("İkinci bölüm.");
    expect(r.listPriceUsd ?? 0).toBe(0);
  });

  it("sends a token kept in the key store as a bearer token", async () => {
    const server = await fakeSpeechServer();
    const keys = new MemoryKeyStore();
    await keys.set("local", "tok");
    await pipelineRunner(keys)(
      JobParamsSchema.parse({
        kind: "story-voice",
        text: "Bir.",
        voice: "anna",
        outDir: dir(),
        speechProvider: "local",
        speechBaseURL: server.url,
      }),
      events,
    );
    expect(server.requests[0]!.auth).toBe("Bearer tok");
  });

  it("reads a Voice Fix take on the local server when the fix is local, and never asks for an ElevenLabs key", async () => {
    const server = await fakeSpeechServer();
    const outDir = join(dir(), "voice-fix");
    const r = (await pipelineRunner(new MemoryKeyStore())(
      JobParamsSchema.parse({
        kind: "voice-fix-say",
        text: "Doğru kelime",
        voice: "my-voice",
        outDir,
        take: 3,
        speechProvider: "local",
        speechBaseURL: server.url,
      }),
      events,
    )) as { file: string; durationS: number; priceUsd: number };
    expect(r.file).toBe(join(outDir, "take-3.wav"));
    expect(r.priceUsd).toBe(0);
    expect(r.durationS).toBeCloseTo(1, 1);
    expect(wavPcm(readFileSync(r.file)).sampleRate).toBe(48000);
    expect(JSON.parse(server.requests[0]!.body)).toMatchObject({
      voice: "my-voice",
      input: "Doğru kelime",
    });
  });

  it("still reads a fix with ElevenLabs when no provider is named", async () => {
    await expect(
      pipelineRunner(new MemoryKeyStore())(
        JobParamsSchema.parse({
          kind: "voice-fix-say",
          text: "x",
          voice: "v",
          outDir: dir(),
          take: 1,
        }),
        events,
      ),
    ).rejects.toThrow(/ElevenLabs/);
  });
});

describe("speech.clone on the local server", () => {
  const catalog = (() => [
    { id: "elevenlabs", keyName: "elevenlabs", endpoint: "https://x" },
    { id: "local", keyName: "local", endpoint: "http://127.0.0.1:8890" },
  ]) as never;
  const cut = vi.fn(() => ({ file: join(dir(), "voice-sample.wav"), durationS: 42 }));

  it("uploads the sample to the server's address without any key", async () => {
    const cloneLocal = vi.fn(async () => ({ voiceId: "made" }));
    const clone = vi.fn();
    const run = makeCloneVoice({
      getKey: async () => undefined,
      catalog,
      cut: (() => {
        const o = cut();
        writeFileSync(o.file, "wav");
        return o;
      }) as never,
      clone,
      cloneLocal: cloneLocal as never,
    });
    const out = await run({
      audioPath: "/j/voice-fix/window.wav",
      spans: [{ startS: 1, endS: 43 }],
      name: "Kilnframe: Talk",
      removeNoise: false,
      provider: "local",
      baseURL: "http://box:9000/",
    });
    expect(out).toMatchObject({ voice: "made", durationS: 42, requiresVerification: false });
    expect(clone).not.toHaveBeenCalled();
    expect(cloneLocal).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "http://box:9000", name: "Kilnframe: Talk" }),
    );
  });

  it("a dry run only cuts the sample", async () => {
    const cloneLocal = vi.fn();
    const run = makeCloneVoice({
      getKey: async () => undefined,
      catalog,
      cut: cut as never,
      cloneLocal: cloneLocal as never,
    });
    const out = await run({
      audioPath: "/j/voice-fix/window.wav",
      rangeStartS: 0,
      rangeEndS: 50,
      name: "n",
      removeNoise: false,
      provider: "local",
      dryRun: true,
    });
    expect(out).toMatchObject({ voice: "", durationS: 42 });
    expect(cloneLocal).not.toHaveBeenCalled();
  });
});
