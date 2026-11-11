import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runAgentProcess } from "../src/providers/agent-run.js";
import { ProviderError } from "../src/providers/types.js";

function node(script: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["-e", script], { stdio: "pipe" });
}

describe("running an agent CLI", () => {
  it("keeps a letter whole when its bytes arrive in two reads", async () => {
    // "ş" is two bytes; the child writes them apart
    const proc = node(
      "process.stdout.write(Buffer.from([0xc5]));setTimeout(()=>process.stdout.write(Buffer.from([0x9f])),50)",
    );
    const r = await runAgentProcess(proc, "", { label: "Test", timeoutMs: 10_000 });
    expect(r.stdout).toBe("ş");
  });

  it("reports what the CLI printed when it exits before reading a large prompt", async () => {
    const proc = node("process.stderr.write('signed out');process.exit(3)");
    const r = await runAgentProcess(proc, "x".repeat(4_000_000), {
      label: "Test",
      timeoutMs: 10_000,
    });
    expect(r.code).toBe(3);
    expect(r.stderr).toBe("signed out");
  });

  it("stops a run past the timeout with a retryable error, also one that ignores SIGTERM", async () => {
    const proc = node("process.on('SIGTERM',()=>{});setInterval(()=>{},1000)");
    const err = await runAgentProcess(proc, "", {
      label: "Test",
      timeoutMs: 200,
      killGraceMs: 200,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(true);
    expect((err as ProviderError).message).toMatch(/did not finish/);
    await new Promise((r) => setTimeout(r, 100));
    expect(proc.signalCode).toBe("SIGKILL");
  });

  it("settles soon after exit when a child keeps the pipes open", async () => {
    const proc = node(
      "require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},4000)'],{stdio:'inherit'});process.stdout.write('done');process.exit(0)",
    );
    const t = Date.now();
    const r = await runAgentProcess(proc, "", {
      label: "Test",
      timeoutMs: 10_000,
      exitGraceMs: 200,
    });
    expect(r.stdout).toBe("done");
    expect(Date.now() - t).toBeLessThan(3_000);
  });
});
