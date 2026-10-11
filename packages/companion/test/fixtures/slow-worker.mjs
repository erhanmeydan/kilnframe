// A stand-in for worker.js: starts a long-running program, reports its pid, then waits.
import { spawn } from "node:child_process";

process.once("message", (params) => {
  if (params.fail) {
    process.send({ type: "failed", message: "model refused" }, () => process.exit(0));
    return;
  }
  if (params.quick) {
    process.send({ type: "progress", message: "Planning scenes" });
    process.send({ type: "done", result: { ok: true } }, () => process.exit(0));
    return;
  }
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  process.send({ type: "progress", message: `child ${child.pid}` });
  setInterval(() => {}, 1000);
});
