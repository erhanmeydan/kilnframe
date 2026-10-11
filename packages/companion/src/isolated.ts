import { fork, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { JobParams } from "./protocol.js";
import type { JobRunner } from "./queue.js";
import type { WorkerMessage } from "./worker.js";

const running = new Set<ChildProcess>();

/**
 * Ends a job process and everything it started. On macOS and Linux the worker leads its own process
 * group: TERM first, so HyperFrames can close its Chrome and the agents can exit, then KILL a few seconds
 * later for whatever is left. Windows has no process groups; taskkill /T ends the tree.
 */
export function killTree(child: ChildProcess, graceMs = 4000): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"]);
    return;
  }
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {
      // already gone
    }
  };
  signal("SIGTERM");
  setTimeout(() => signal("SIGKILL"), graceMs).unref();
}

/** Stops every running job process; the companion calls this when it quits. */
export function killAllJobs(): void {
  for (const child of running) killTree(child, 0);
}

/** Runs each job in its own process, so a stopped job really stops (one render at a time). */
export function isolatedRunner(
  workerPath = fileURLToPath(new URL("./worker.js", import.meta.url)),
): JobRunner {
  return (params: JobParams, events) =>
    new Promise((resolve, reject) => {
      const child = fork(workerPath, [], {
        detached: process.platform !== "win32",
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      running.add(child);
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        running.delete(child);
        events.signal.removeEventListener("abort", onAbort);
        fn();
      };
      const onAbort = () => {
        killTree(child);
        finish(() => reject(new Error("The job was stopped.")));
      };
      if (events.signal.aborted) return onAbort();
      events.signal.addEventListener("abort", onAbort, { once: true });
      child.on("message", (m: WorkerMessage) => {
        if (m.type === "progress") events.progress(m.message);
        else if (m.type === "done") finish(() => resolve(m.result));
        else if (m.type === "failed") finish(() => reject(new Error(m.message)));
      });
      // close, not exit: it comes after the IPC channel has delivered the last message
      child.on("close", (code) =>
        finish(() =>
          reject(new Error(`The job process ended unexpectedly (exit ${code ?? "signal"}).`)),
        ),
      );
      child.on("error", (err) => finish(() => reject(err)));
      child.send(params);
    });
}
