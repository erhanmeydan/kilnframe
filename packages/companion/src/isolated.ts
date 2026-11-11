import { fork, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { JobParams } from "./protocol.js";
import type { JobRunner } from "./queue.js";
import type { WorkerMessage } from "./worker.js";

const running = new Set<ChildProcess>();

/** True once no process of the group is left (a zombie still counts until it is reaped). */
function groupGone(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Resolves when the child has closed, or after `ms`. */
function closed(child: ChildProcess, ms: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Ends a job process and everything it started, and resolves once they are gone (or KILL had a second).
 * On macOS and Linux the worker leads its own process group: TERM first, so HyperFrames can close its Chrome
 * and the agents can exit, then KILL after `graceMs` for whatever is left. Windows has no process groups;
 * taskkill /T ends the tree at once.
 */
export function killTree(child: ChildProcess, graceMs = 4000): Promise<void> {
  const pid = child.pid;
  if (!pid) return Promise.resolve();
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"]);
    return closed(child, 2000);
  }
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {
      // already gone
    }
  };
  signal("SIGTERM");
  const start = Date.now();
  return new Promise((resolve) => {
    let killed = false;
    const timer = setInterval(() => {
      const waited = Date.now() - start;
      if (groupGone(pid) || waited > graceMs + 1000) {
        clearInterval(timer);
        resolve();
      } else if (!killed && waited >= graceMs) {
        killed = true;
        signal("SIGKILL");
      }
    }, 50);
  });
}

/**
 * Stops every running job process and resolves when they are gone; the companion calls this when it quits.
 * A short grace still lets HyperFrames close its Chrome.
 */
export function killAllJobs(graceMs = 1500): Promise<void> {
  return Promise.all([...running].map((child) => killTree(child, graceMs))).then(() => {});
}

/** The last resort at exit, where nothing can be waited for: KILL (taskkill on Windows) at once. */
export function killAllJobsNow(): void {
  for (const child of running) {
    const pid = child.pid;
    if (!pid) continue;
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"]);
    else
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // already gone
      }
  }
}

/** Runs each job in its own process, so a stopped job really stops (one render at a time). */
export function isolatedRunner(
  workerPath = fileURLToPath(new URL("./worker.js", import.meta.url)),
  o: { graceMs?: number } = {},
): JobRunner {
  return (params: JobParams, events) =>
    new Promise((resolve, reject) => {
      const child = fork(workerPath, [], {
        detached: process.platform !== "win32",
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      running.add(child);
      let settled = false;
      /** Stopped by the editor: settles only when the old processes are gone, so the next job starts clean. */
      let stopping = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        running.delete(child);
        events.signal.removeEventListener("abort", onAbort);
        fn();
      };
      const onAbort = () => {
        if (stopping) return;
        stopping = true;
        void killTree(child, o.graceMs).then(() =>
          finish(() => reject(new Error("The job was stopped."))),
        );
      };
      if (events.signal.aborted) return onAbort();
      events.signal.addEventListener("abort", onAbort, { once: true });
      child.on("message", (m: WorkerMessage) => {
        if (stopping) return;
        if (m.type === "progress") events.progress(m.message);
        else if (m.type === "done") finish(() => resolve(m.result));
        else if (m.type === "failed")
          finish(() => reject(Object.assign(new Error(m.message), { kind: m.kind })));
      });
      // close, not exit: it comes after the IPC channel has delivered the last message
      child.on("close", (code) => {
        if (stopping) return;
        finish(() =>
          reject(new Error(`The job process ended unexpectedly (exit ${code ?? "signal"}).`)),
        );
      });
      child.on("error", (err) => {
        if (!stopping) finish(() => reject(err));
      });
      child.send(params);
    });
}
