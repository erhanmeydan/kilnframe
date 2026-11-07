import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { keptFresh, runAgent } from "../src/providers/agent-binary.js";
import { claudeCodeStatusAsync, ClaudeCodeProvider } from "../src/providers/claude-code.js";
import { codexStatusAsync } from "../src/providers/codex.js";
import { testProvider } from "../src/providers/test.js";

const dirs: string[] = [];
const saved = { claude: process.env.KILNFRAME_CLAUDE, codex: process.env.KILNFRAME_CODEX };
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (saved.claude === undefined) delete process.env.KILNFRAME_CLAUDE;
  else process.env.KILNFRAME_CLAUDE = saved.claude;
  if (saved.codex === undefined) delete process.env.KILNFRAME_CODEX;
  else process.env.KILNFRAME_CODEX = saved.codex;
});

/** A stand-in CLI: a shell script answering by its arguments. */
function fakeCli(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kf-agent-"));
  dirs.push(dir);
  const file = join(dir, "cli");
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

describe.skipIf(process.platform === "win32")("agent CLIs asked without blocking", () => {
  it("reads Claude Code's version and sign-in as the sync check does", async () => {
    process.env.KILNFRAME_CLAUDE = fakeCli(
      `case "$1" in --version) echo "2.1.300 (Claude Code)";; auth) echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}';; esac`,
    );
    expect(await claudeCodeStatusAsync()).toEqual({
      installed: true,
      version: "2.1.300",
      loggedIn: true,
      authMethod: "claude.ai",
      subscription: "max",
    });
  });

  it("says a missing CLI is not installed", async () => {
    process.env.KILNFRAME_CLAUDE = join(tmpdir(), "kf-no-such-cli");
    process.env.KILNFRAME_CODEX = join(tmpdir(), "kf-no-such-cli");
    expect((await claudeCodeStatusAsync()).installed).toBe(false);
    expect((await codexStatusAsync()).installed).toBe(false);
  });

  it("reads Codex's sign-in", async () => {
    process.env.KILNFRAME_CODEX = fakeCli(
      `case "$1" in --version) echo "codex-cli 0.155.1";; login) echo "Logged in using ChatGPT" >&2;; esac`,
    );
    expect(await codexStatusAsync()).toEqual({
      installed: true,
      version: "0.155.1",
      loggedIn: true,
      method: "chatgpt",
    });
  });

  it("runs a CLI and gives its exit code and output, or the error that kept it from running", async () => {
    process.env.KILNFRAME_CODEX = fakeCli(`echo out; echo err >&2; exit 3`);
    const r = await runAgent("codex", [], { timeout: 5_000 });
    expect(r).toMatchObject({ status: 3, stdout: "out\n", stderr: "err\n" });
    process.env.KILNFRAME_CODEX = join(tmpdir(), "kf-no-such-cli");
    expect((await runAgent("codex", [], { timeout: 5_000 })).error).toBeInstanceOf(Error);
  });

  it("a connection test checks a signed-out Claude Code without blocking, in the same words", async () => {
    process.env.KILNFRAME_CLAUDE = fakeCli(
      `case "$1" in --version) echo "2.1.300";; auth) echo '{"loggedIn":false}';; esac`,
    );
    const r = await testProvider(new ClaudeCodeProvider({ model: "claude-opus-5-5" }));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/not signed in/);
  });
});

describe("kept fresh in the background", () => {
  it("asks blocking only the first time; later it gives the last answer and asks again beside", async () => {
    let now = 0;
    let syncReads = 0;
    let asyncReads = 0;
    const kept = keptFresh(
      () => (syncReads++, ["sync"]),
      async () => (asyncReads++, ["async"]),
      5_000,
      () => now,
    );
    expect(kept()).toEqual(["sync"]);
    now = 6_000;
    // stale: the last answer at once, a fresh one asked for beside
    expect(kept()).toEqual(["sync"]);
    await kept.ready();
    expect(kept()).toEqual(["async"]);
    expect(syncReads).toBe(1);
    expect(asyncReads).toBe(1);
  });

  it("can be filled without blocking before it is first needed", async () => {
    let syncReads = 0;
    const kept = keptFresh(
      () => (syncReads++, ["sync"]),
      async () => ["async"],
      5_000,
      () => 0,
    );
    await kept.ready();
    expect(kept()).toEqual(["async"]);
    expect(syncReads).toBe(0);
  });
});

describe("the connection test's check", () => {
  it("is the provider's own check without blocking when it has one", async () => {
    const provider = {
      name: "x",
      model: "m",
      capabilities: { vision: true, structuredOutput: true, contextWindow: 0 },
      preflight: () => {
        throw new Error("blocking check");
      },
      preflightAsync: async () => {
        throw new Error("check beside");
      },
      complete: async () => ({ text: "red", model: "m" }),
    };
    expect((await testProvider(provider as never)).message).toBe("check beside");
  });
});
