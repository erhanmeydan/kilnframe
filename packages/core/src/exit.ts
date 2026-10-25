import { createRequire } from "node:module";

const loaded = () =>
  Object.keys(createRequire(import.meta.url).cache).some((f) =>
    f.endsWith("onnxruntime_binding.node"),
  );

/**
 * Ends the process with `code`, like process.exit. On Intel Macs speech recognition runs on onnxruntime
 * 1.23.2, the last release with a macOS x64 library (packages/app/scripts/onnxruntime-x64.mjs), which
 * aborts ("mutex lock failed") when process.exit() runs its static destructors before Node has released
 * the addon; macOS then reports a crash. When the event loop ends by itself Node releases the addon first,
 * so there the process is left to end on its own, and killed after a few seconds if something keeps it open.
 */
export function exitProcess(code: number): void {
  if (process.platform !== "darwin" || process.arch !== "x64" || !loaded()) process.exit(code);
  process.exitCode = code;
  if (process.connected) process.disconnect();
  setTimeout(() => process.kill(process.pid, "SIGKILL"), 3000).unref();
}
