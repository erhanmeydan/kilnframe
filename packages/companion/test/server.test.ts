import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  MemoryKeyStore,
  startCompanion,
  type Companion,
  type JobParams,
  type KeyStore,
  type ServerMessage,
} from "../src/index.js";

const TOKEN = "t".repeat(64);
const params: JobParams = {
  audioPath: "/tmp/a.wav",
  outDir: "/tmp/out",
  style: "kil-lacivert",
  mode: "fullscreen",
  fps: "30000/1001",
  sequenceSize: "1920x1080",
};

let companion: Companion | undefined;
afterEach(async () => {
  await companion?.close();
  companion = undefined;
});

/** Connects, collects every server message, and resolves helpers. */
async function connect(port: number, host = "127.0.0.1") {
  const ws = new WebSocket(`ws://${host}:${port}`);
  const messages: ServerMessage[] = [];
  const waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] =
    [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString()) as ServerMessage;
    messages.push(m);
    for (const w of [...waiters]) {
      if (w.pred(m)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m);
      }
    }
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() })),
  );
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return {
    ws,
    messages,
    closed,
    send: (m: unknown) => ws.send(JSON.stringify(m)),
    next: (pred: (m: ServerMessage) => boolean) =>
      new Promise<ServerMessage>((resolve) => {
        const found = messages.find(pred);
        if (found) resolve(found);
        else waiters.push({ pred, resolve });
      }),
  };
}

describe("companion server", () => {
  it("answers on the IPv6 loopback too, where Windows sends localhost", async () => {
    companion = await startCompanion({
      token: TOKEN,
      keys: new MemoryKeyStore(),
      runner: async () => null,
      version: "test",
      port: 0,
    });
    const c = await connect(companion.port, "[::1]");
    c.send({ type: "hello", token: TOKEN });
    expect((await c.next((m) => m.type === "ready")).type).toBe("ready");
    c.ws.close();
  });

  it("rejects a wrong token and a silent client", async () => {
    companion = await startCompanion({
      token: TOKEN,
      keys: new MemoryKeyStore(),
      runner: async () => null,
      version: "test",
      port: 0,
      helloTimeoutMs: 200,
    });
    const bad = await connect(companion.port);
    bad.send({ type: "hello", token: "wrong" });
    expect((await bad.closed).reason).toBe("unauthorized");
    const silent = await connect(companion.port);
    expect((await silent.closed).reason).toBe("hello timeout");
  });

  it("refuses commands before hello", async () => {
    companion = await startCompanion({
      token: TOKEN,
      keys: new MemoryKeyStore(),
      runner: async () => null,
      version: "test",
      port: 0,
    });
    const c = await connect(companion.port);
    c.send({ type: "status" });
    expect((await c.closed).reason).toBe("unauthorized");
  });

  it("runs jobs one at a time and reports progress and results", async () => {
    const order: string[] = [];
    companion = await startCompanion({
      token: TOKEN,
      keys: new MemoryKeyStore(),
      version: "test",
      port: 0,
      runner: async (p, events) => {
        order.push(`start ${p.style}`);
        events.progress(`working on ${p.style}`);
        await new Promise((r) => setTimeout(r, 30));
        order.push(`end ${p.style}`);
        if (p.style === "boom") throw new Error("render failed");
        return { ok: p.style };
      },
    });
    const c = await connect(companion.port);
    c.send({ type: "hello", token: TOKEN });
    expect(await c.next((m) => m.type === "ready")).toMatchObject({ protocol: 1, version: "test" });
    c.send({ type: "job.start", params: { ...params, style: "a" } });
    c.send({ type: "job.start", params: { ...params, style: "boom" } });
    const done = await c.next((m) => m.type === "job.done");
    const failed = await c.next((m) => m.type === "job.error");
    expect(done).toMatchObject({ result: { ok: "a" } });
    expect(failed).toMatchObject({ message: "render failed" });
    expect(order).toEqual(["start a", "end a", "start boom", "end boom"]);
    expect(c.messages.some((m) => m.type === "job.progress" && m.message === "working on a")).toBe(
      true,
    );
    c.send({ type: "status" });
    const status = await c.next((m) => m.type === "status");
    expect(status.type === "status" && status.jobs.map((j) => j.state)).toEqual(["done", "failed"]);

    // a panel that missed the broadcast (reload, sleep) asks again on a new connection
    const late = await connect(companion.port);
    late.send({ type: "hello", token: TOKEN });
    await late.next((m) => m.type === "ready");
    const ids = status.type === "status" ? status.jobs.map((j) => j.id) : [];
    late.send({ type: "job.get", jobId: ids[0] });
    expect(await late.next((m) => m.type === "job.done")).toMatchObject({
      jobId: ids[0],
      result: { ok: "a" },
    });
    late.send({ type: "job.get", jobId: ids[1] });
    expect(await late.next((m) => m.type === "job.error")).toMatchObject({
      message: "render failed",
    });
    late.send({ type: "job.get", jobId: "nope" });
    expect(await late.next((m) => m.type === "job.state")).toMatchObject({ state: "unknown" });
  });

  it("answers system checks", async () => {
    companion = await startCompanion({
      token: TOKEN,
      keys: new MemoryKeyStore(),
      runner: async () => null,
      version: "test",
      port: 0,
      systemCheck: async () => ({ gpu: { mode: "hardware" } }),
      prepareModels: async (onProgress) => onProgress("Downloading speech model: 50%"),
      listModels: async (provider) => [{ id: `${provider}-model` }],
    });
    const c = await connect(companion.port);
    c.send({ type: "hello", token: TOKEN });
    await c.next((m) => m.type === "ready");
    c.send({ type: "system.check" });
    expect(await c.next((m) => m.type === "system")).toMatchObject({
      report: { gpu: { mode: "hardware" } },
    });
    c.send({ type: "models.list", provider: "anthropic" });
    expect(await c.next((m) => m.type === "models")).toMatchObject({
      models: [{ id: "anthropic-model" }],
    });
    c.send({ type: "models.prepare" });
    await c.next((m) => m.type === "models.ready");
    expect(c.messages.some((m) => m.type === "models.progress" && m.message.includes("50%"))).toBe(
      true,
    );
  });

  it("answers style and job folder requests and acknowledges jobs with their ref", async () => {
    companion = await startCompanion({
      token: TOKEN,
      keys: new MemoryKeyStore(),
      runner: async () => null,
      version: "test",
      port: 0,
      listStyles: async () => [{ name: "kil-lacivert", displayName: "Kil Lacivert" }],
      prepareJob: async (_project, sequence) => `/tmp/${sequence}`,
    });
    const c = await connect(companion.port);
    c.send({ type: "hello", token: TOKEN });
    await c.next((m) => m.type === "ready");
    c.send({ type: "styles.list" });
    expect(await c.next((m) => m.type === "styles")).toMatchObject({
      styles: [{ displayName: "Kil Lacivert" }],
    });
    c.send({ type: "job.prepare", sequenceName: "Sequence 01" });
    expect(await c.next((m) => m.type === "job.prepared")).toMatchObject({
      jobDir: "/tmp/Sequence 01",
    });
    c.send({ type: "job.start", params: { ...params, provider: "claude-code" }, ref: "r1" });
    expect(await c.next((m) => m.type === "job.accepted")).toMatchObject({ ref: "r1" });
  });

  it("validates job parameters", async () => {
    companion = await startCompanion({
      token: TOKEN,
      keys: new MemoryKeyStore(),
      runner: async () => null,
      version: "test",
      port: 0,
    });
    const c = await connect(companion.port);
    c.send({ type: "hello", token: TOKEN });
    await c.next((m) => m.type === "ready");
    c.send({ type: "job.start", params: { ...params, sequenceSize: "big" } });
    expect(await c.next((m) => m.type === "error")).toMatchObject({ type: "error" });
  });

  it("stores keys without ever echoing them", async () => {
    const failing: KeyStore = {
      get: async () => undefined,
      set: async () => {
        throw new Error("keychain locked: sk-secret-123");
      },
      delete: async () => false,
    };
    companion = await startCompanion({
      token: TOKEN,
      keys: failing,
      runner: async () => null,
      version: "test",
      port: 0,
    });
    const c = await connect(companion.port);
    c.send({ type: "hello", token: TOKEN });
    await c.next((m) => m.type === "ready");
    c.send({ type: "keys.set", provider: "anthropic", key: "sk-secret-123" });
    const err = await c.next((m) => m.type === "error");
    expect(JSON.stringify(err)).not.toContain("sk-secret");
    c.send({ type: "keys.has", provider: "anthropic" });
    expect(await c.next((m) => m.type === "keys.has")).toMatchObject({ present: false });
  });

  it("listens on loopback only", async () => {
    companion = await startCompanion({
      token: TOKEN,
      keys: new MemoryKeyStore(),
      runner: async () => null,
      version: "test",
      port: 0,
    });
    const { networkInterfaces } = await import("node:os");
    const external = Object.values(networkInterfaces())
      .flat()
      .find((i) => i && i.family === "IPv4" && !i.internal)?.address;
    if (!external) return;
    const ws = new WebSocket(`ws://${external}:${companion.port}`);
    const outcome = await new Promise<string>((resolve) => {
      ws.once("open", () => resolve("open"));
      ws.once("error", () => resolve("refused"));
    });
    expect(outcome).toBe("refused");
  });

  it("queues style jobs like renders and deletes the editor's styles on request", async () => {
    const seen: unknown[] = [];
    const deleted: string[] = [];
    companion = await startCompanion({
      token: TOKEN,
      keys: new MemoryKeyStore(),
      version: "test",
      port: 0,
      runner: async (p) => {
        seen.push(p);
        return { kind: "style", name: "neon-gece" };
      },
      deleteStyle: async (name) => {
        deleted.push(name);
      },
    });
    const c = await connect(companion.port);
    c.send({ type: "hello", token: TOKEN });
    await c.next((m) => m.type === "ready");
    c.send({
      type: "job.start",
      ref: "s1",
      params: { kind: "style", description: "loş neon gece", references: [] },
    });
    expect(await c.next((m) => m.type === "job.done")).toMatchObject({
      result: { name: "neon-gece" },
    });
    expect(seen[0]).toMatchObject({ kind: "style", description: "loş neon gece" });
    c.send({ type: "status" });
    const status = await c.next((m) => m.type === "status");
    expect(status.type === "status" && status.jobs[0]?.style).toBe("style-create");
    c.send({
      type: "job.start",
      params: { kind: "style", references: [1, 2, 3, 4, 5].map((i) => ({ path: `/r${i}.png` })) },
    });
    expect(await c.next((m) => m.type === "error")).toBeTruthy();
    c.send({ type: "styles.delete", name: "neon-gece" });
    expect(await c.next((m) => m.type === "styles.deleted")).toMatchObject({ name: "neon-gece" });
    expect(deleted).toEqual(["neon-gece"]);
  });

  it("takes story jobs and answers voice requests", async () => {
    const seen: { kind?: string }[] = [];
    const played: string[] = [];
    companion = await startCompanion({
      token: TOKEN,
      keys: new MemoryKeyStore(),
      version: "test",
      port: 0,
      runner: async (p) => {
        seen.push(p as { kind?: string });
        return { kind: (p as { kind?: string }).kind };
      },
      listVoices: async () => ({
        provider: "gemini",
        model: "gemini-3.8-flash-tts",
        voices: [{ name: "Kore", character: "Firm" }],
        keySet: false,
      }),
      previewVoice: async (voice, language) => {
        played.push(`${voice} ${language}`);
      },
    });
    const c = await connect(companion.port);
    c.send({ type: "hello", token: TOKEN });
    await c.next((m) => m.type === "ready");
    c.send({
      type: "job.start",
      params: { kind: "story-write", brief: "kahve", durationS: 45, language: "tr" },
    });
    await c.next(
      (m) => m.type === "job.done" && (m.result as { kind?: string }).kind === "story-write",
    );
    c.send({
      type: "job.start",
      params: { kind: "story-voice", text: "Bir keçi çobanı.", voice: "Kore", outDir: "/tmp/x" },
    });
    await c.next(
      (m) => m.type === "job.done" && (m.result as { kind?: string }).kind === "story-voice",
    );
    expect(seen.map((p) => p.kind)).toEqual(["story-write", "story-voice"]);
    c.send({
      type: "job.start",
      params: { kind: "story-write", brief: "x", durationS: 2, language: "tr" },
    });
    expect(await c.next((m) => m.type === "error")).toBeTruthy();
    c.send({ type: "speech.voices" });
    expect(await c.next((m) => m.type === "voices")).toMatchObject({
      keySet: false,
      provider: "gemini",
    });
    c.send({ type: "speech.preview", voice: "Kore", language: "tr" });
    expect(await c.next((m) => m.type === "speech.played")).toMatchObject({ voice: "Kore" });
    expect(played).toEqual(["Kore tr"]);
  });
});
