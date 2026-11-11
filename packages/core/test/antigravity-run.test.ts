import { spawn } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** What the fake `agy` prints for a call; tests set it. */
interface Reply {
  stdout?: string;
  stderr?: string;
  code?: number;
  delayMs?: number;
}
let reply: (args: string[]) => Reply = () => ({});
let running = 0;
let most = 0;
let promptRuns = 0;

vi.mock("../src/providers/agent-binary.js", () => ({
  spawnAgent: (_agent: string, args: string[]) => {
    const r = reply(args);
    const script = `setTimeout(()=>{process.stdout.write(${JSON.stringify(r.stdout ?? "")});process.stderr.write(${JSON.stringify(r.stderr ?? "")});process.exit(${r.code ?? 0})},${r.delayMs ?? 0})`;
    const proc = spawn(process.execPath, ["-e", script], { stdio: "pipe" });
    if (args.includes("-p=")) {
      promptRuns++;
      running++;
      most = Math.max(most, running);
      proc.on("exit", () => running--);
    }
    return proc;
  },
}));

const {
  ANTIGRAVITY_UNREACHABLE,
  AntigravityProvider,
  antigravityStatus,
  antigravityTiming,
  forgetAgyModels,
  requestSlots,
} = await import("../src/providers/antigravity.js");

const MODELS = "Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\n";
const ok = (text: string) =>
  `{"event":"result","result":{"status":"SUCCESS","response":${JSON.stringify(text)}}}\n`;
const req = {
  system: "s",
  messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
  maxTokens: 100,
  purpose: "compose",
};
const signedIn = (args: string[], prompt: Reply): Reply =>
  args[0] === "--version"
    ? { stdout: "1.5.5\n" }
    : args[0] === "models"
      ? { stdout: MODELS }
      : prompt;

beforeEach(() => {
  forgetAgyModels();
  running = 0;
  most = 0;
  promptRuns = 0;
  antigravityTiming.sleep = () => Promise.resolve();
});

describe("Antigravity status", () => {
  it("tells signed out from not reachable", async () => {
    reply = (a) =>
      a[0] === "--version" ? { stdout: "1.5.5\n" } : { stderr: "dial tcp: i/o timeout", code: 1 };
    const s = await antigravityStatus();
    expect(s).toEqual({ installed: true, version: "1.5.5", loggedIn: false, unreachable: true });
    expect(() => new AntigravityProvider({ model: "" }).preflight()).toThrow(
      ANTIGRAVITY_UNREACHABLE,
    );

    forgetAgyModels();
    reply = (a) =>
      a[0] === "--version" ? { stdout: "1.5.5\n" } : { stderr: "Error: not signed in", code: 1 };
    expect((await antigravityStatus()).unreachable).toBe(false);
    expect(() => new AntigravityProvider({ model: "" }).preflight()).toThrow(/not signed in/);
  });

  it("asks agy for the models once and shares the answer", async () => {
    let calls = 0;
    reply = (a) => {
      if (a[0] === "models") calls++;
      return signedIn(a, {});
    };
    const p = new AntigravityProvider({ model: "" });
    await antigravityStatus();
    p.preflight();
    expect((await p.listModels()).map((m) => m.id)).toEqual(["gemini-3.8-flash-high"]);
    await antigravityStatus();
    expect(calls).toBe(1);
  });
});

describe("Antigravity requests", () => {
  it("sends two at once, then one at a time after Google says it is busy", async () => {
    let busy = 1;
    reply = (a) =>
      signedIn(a, {
        delayMs: 150,
        ...(a.includes("-p=") && busy-- > 0
          ? {
              stderr: "RESOURCE_EXHAUSTED (code 429): exhausted your capacity. Resets in 0s.",
              code: 1,
            }
          : { stdout: ok("done") }),
      });
    const p = new AntigravityProvider({ model: "" });
    const first = await Promise.all([p.complete(req), p.complete(req)]);
    expect(first.map((r) => r.text)).toEqual(["done", "done"]);
    // two ran together; the capacity error on stderr alone was tried again
    expect(most).toBe(2);
    expect(promptRuns).toBe(3);
    most = 0;
    await Promise.all([p.complete(req), p.complete(req), p.complete(req)]);
    expect(most).toBe(1);
  });

  it("keeps a queue that can be lowered", async () => {
    const slots = requestSlots(2);
    let now = 0;
    let top = 0;
    const task = () =>
      slots.run(async () => {
        now++;
        top = Math.max(top, now);
        await new Promise((r) => setTimeout(r, 10));
        now--;
      });
    await Promise.all([task(), task(), task()]);
    expect(top).toBe(2);
    slots.lower(1);
    top = 0;
    await Promise.all([task(), task(), task()]);
    expect(top).toBe(1);
  });
});
