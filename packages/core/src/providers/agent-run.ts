import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { ProviderError } from "./types.js";

/** How the agent CLIs (Claude Code, Codex, Antigravity) are run to the end and their output collected. */

export interface AgentRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface AgentRunOptions {
  /** The program's name in messages ("Claude Code"). */
  label: string;
  timeoutMs: number;
  /** After the process exits, how long to wait for its pipes to close (a grandchild may still hold them). */
  exitGraceMs?: number;
  /** After SIGTERM, how long before SIGKILL. */
  killGraceMs?: number;
  platform?: NodeJS.Platform;
  /** Ends the process and its children; replaced in tests. */
  kill?: (proc: ChildProcess) => void;
}

/**
 * Ends a process and its children. On Windows an npm shim runs `node script.js`, and killing that leaves the
 * native agent running with the pipes open, so taskkill ends the whole tree. Elsewhere SIGTERM, then SIGKILL
 * for a program that ignores it.
 */
export function killTree(
  proc: ChildProcess,
  platform: NodeJS.Platform = process.platform,
  killGraceMs = 5_000,
): void {
  if (platform === "win32" && proc.pid) {
    spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    }).on("error", () => proc.kill());
    return;
  }
  proc.kill("SIGTERM");
  setTimeout(() => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  }, killGraceMs).unref();
}

/**
 * Writes `input` to the process, collects its output as UTF-8 and settles once: on close, a little after exit
 * when a child keeps the pipes open, or with a retryable error when it runs past the timeout.
 */
export function runAgentProcess(
  proc: ChildProcessWithoutNullStreams,
  input: string,
  o: AgentRunOptions,
): Promise<AgentRunResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    // decoded as a stream, so a Turkish letter split across two reads stays whole
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (c: string) => (stdout += c));
    proc.stderr.on("data", (c: string) => (stderr += c));
    let settled = false;
    let timedOut = false;
    const timers: NodeJS.Timeout[] = [];
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      fn();
    };
    const timeoutError = () =>
      new ProviderError(
        `${o.label} did not finish within ${Math.round(o.timeoutMs / 60_000)} minutes and was stopped. Try again.`,
        true,
      );
    timers.push(
      setTimeout(() => {
        timedOut = true;
        (o.kill ?? ((p) => killTree(p, o.platform, o.killGraceMs)))(proc);
        // a process that cannot be ended must not hold the job forever
        timers.push(setTimeout(() => settle(() => reject(timeoutError())), 15_000));
      }, o.timeoutMs),
    );
    proc.on("error", (err) =>
      settle(() => reject(new ProviderError(`Could not start ${o.label}: ${err.message}`, false))),
    );
    const done = (code: number | null) =>
      settle(() =>
        timedOut ? reject(timeoutError()) : resolve({ code: code ?? 1, stdout, stderr }),
      );
    proc.on("close", done);
    proc.on("exit", (code) => {
      if (!settled) timers.push(setTimeout(() => done(code), o.exitGraceMs ?? 2_000));
    });
    // a CLI that exits before reading its prompt breaks the pipe; close then reports what it printed
    proc.stdin.on("error", () => {});
    proc.stdin.end(input);
  });
}
