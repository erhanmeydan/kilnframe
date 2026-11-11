// One job in its own process (isolated.ts starts it): the companion can stop a job by ending this process
// and everything it started (Claude Code, Codex, HyperFrames with its Chrome, FFmpeg), which a promise
// inside the companion could not do.
import "./system-certs.js";
import { spawnSync } from "node:child_process";
import { OsKeyStore } from "./keys.js";
import type { JobParams } from "./protocol.js";
import { errorKind } from "./queue.js";
import { pipelineRunner } from "./runner.js";

export type WorkerMessage =
  | { type: "progress"; message: string }
  | { type: "done"; result: unknown }
  | { type: "failed"; message: string; kind?: string | undefined };

const send = (m: WorkerMessage) =>
  new Promise<void>((resolve) =>
    process.send ? process.send(m, undefined, {}, () => resolve()) : resolve(),
  );

/**
 * The companion is gone (killed without its own clean-up, as Windows does on Quit, or crashed): nobody would
 * take the result, so this job ends itself and everything it started instead of spending tokens for nothing.
 */
process.once("disconnect", () => {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(process.pid), "/T", "/F"]);
    process.exit(1);
  }
  // this process leads its group (isolated.ts): TERM the rest, KILL what is left, which ends this one too
  process.on("SIGTERM", () => {});
  const group = (sig: NodeJS.Signals) => {
    try {
      process.kill(-process.pid, sig);
    } catch {
      // already gone
    }
  };
  group("SIGTERM");
  setTimeout(() => group("SIGKILL"), 1500);
});

process.once("message", (params: JobParams) => {
  const controller = new AbortController();
  pipelineRunner(new OsKeyStore())(params, {
    progress: (message) => void send({ type: "progress", message }),
    signal: controller.signal,
  })
    .then((result) => send({ type: "done", result }))
    .catch((err: unknown) =>
      send({
        type: "failed",
        message: err instanceof Error ? err.message : String(err),
        kind: errorKind(err),
      }),
    )
    .finally(() => process.exit(0));
});
