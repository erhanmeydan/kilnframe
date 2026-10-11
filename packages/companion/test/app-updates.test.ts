import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { appUpdatesFromParent } from "../src/app-updates.js";
import {
  MemoryKeyStore,
  startCompanion,
  type Companion,
  type ServerMessage,
} from "../src/index.js";

const TOKEN = "t".repeat(64);
let companion: Companion | undefined;
afterEach(async () => {
  await companion?.close();
  companion = undefined;
});

/** A stand-in for the app's end of the IPC channel. */
function fakeParent() {
  const emitter = new EventEmitter();
  const sent: unknown[] = [];
  const channel = {
    send: (m: unknown) => sent.push(m),
    on: (event: "message", l: (m: unknown) => void) => emitter.on(event, l),
  };
  return { channel, sent, say: (m: unknown) => emitter.emit("message", m) };
}

async function client(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages: ServerMessage[] = [];
  ws.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as ServerMessage));
  await new Promise((r) => ws.once("open", r));
  const until = async (pred: (m: ServerMessage) => boolean) => {
    for (let i = 0; i < 100; i++) {
      const found = messages.find(pred);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("message never came");
  };
  return { send: (m: unknown) => ws.send(JSON.stringify(m)), until, messages };
}

describe("app updates", () => {
  it("is off when the companion runs on its own", () => {
    expect(appUpdatesFromParent({ on: () => undefined })).toBeUndefined();
  });

  it("relays the app's state to the panel and asks the app to install", async () => {
    const parent = fakeParent();
    const updates = appUpdatesFromParent(parent.channel);
    parent.say({
      type: "update.state",
      state: { status: "available", current: "0.1.0", version: "0.2.0" },
    });
    companion = await startCompanion({
      token: TOKEN,
      keys: new MemoryKeyStore(),
      runner: async () => null,
      version: "0.1.0",
      port: 0,
      appUpdates: updates,
    });
    const c = await client(companion.port);
    c.send({ type: "hello", token: TOKEN, protocol: 1 });
    // a panel that connects later still learns about the update
    expect(await c.until((m) => m.type === "app.update")).toMatchObject({
      update: { status: "available", version: "0.2.0" },
    });
    parent.say({
      type: "update.state",
      state: { status: "downloading", current: "0.1.0", version: "0.2.0", percent: 40 },
    });
    expect(
      await c.until((m) => m.type === "app.update" && m.update.status === "downloading"),
    ).toBeTruthy();
    c.send({ type: "app.update.install" });
    for (let i = 0; i < 50 && !parent.sent.length; i++) await new Promise((r) => setTimeout(r, 10));
    expect(parent.sent).toEqual([{ type: "update.install" }]);
  });

  it("does not install while a job runs", async () => {
    const parent = fakeParent();
    let finish = () => {};
    companion = await startCompanion({
      token: TOKEN,
      keys: new MemoryKeyStore(),
      runner: () => new Promise((r) => (finish = () => r(null))),
      version: "0.1.0",
      port: 0,
      appUpdates: appUpdatesFromParent(parent.channel),
    });
    const c = await client(companion.port);
    c.send({ type: "hello", token: TOKEN });
    await c.until((m) => m.type === "ready");
    c.send({
      type: "job.start",
      params: {
        audioPath: "/tmp/a.wav",
        outDir: "/tmp/out",
        style: "kil-lacivert",
        mode: "fullscreen",
        fps: "25",
        sequenceSize: "1920x1080",
      },
    });
    await c.until((m) => m.type === "job.queued");
    c.send({ type: "app.update.install" });
    await c.until((m) => m.type === "app.update.busy");
    expect(parent.sent).toEqual([]);
    finish();
  });
});
