// One job in its own process (isolated.ts starts it): the companion can stop a job by ending this process
// and everything it started (Claude Code, Codex, HyperFrames with its Chrome, FFmpeg), which a promise
// inside the companion could not do.
import "./system-certs.js";
import { exitProcess } from "@kilnframe/core";
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
    .finally(() => exitProcess(0));
});
