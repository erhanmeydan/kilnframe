// On Windows 10 with ESET the app's sandboxed GPU process crashed at start (exit -1073741819, an access
// violation) and took the app with it: Kilnframe closed itself every time it opened (1 Nov 2026). Running the
// GPU process without its sandbox fixed it there. That is kept to the computers where it crashed: the first
// crash leaves a marker, and from then on the app starts that way. It only shows its own local pages.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** ~/.kilnframe/gpu-sandbox-off: there once the GPU process crashed on this computer. */
export const gpuSandboxMarker = (home: string) => join(home, "gpu-sandbox-off");

/** Whether this start runs the GPU process without its sandbox. */
export function gpuSandboxOff(platform: NodeJS.Platform, home: string): boolean {
  return platform === "win32" && existsSync(gpuSandboxMarker(home));
}

/** The ways a child process ends that count as the GPU process failing (Electron's child-process-gone). */
const FAILED = new Set(["crashed", "abnormal-exit", "launch-failed"]);

/**
 * What a gone child process asks for: nothing; "mark" (start without the sandbox next time); or "relaunch"
 * as well, at once, when no job would be lost.
 */
export function onChildGone(s: {
  platform: NodeJS.Platform;
  type: string;
  reason: string;
  /** The marker is already there (this start already runs without the sandbox). */
  marked: boolean;
  /** A job runs: restarting the app would end it. */
  busy: boolean;
}): "none" | "mark" | "relaunch" {
  if (s.platform !== "win32" || s.type !== "GPU" || !FAILED.has(s.reason) || s.marked)
    return "none";
  return s.busy ? "mark" : "relaunch";
}

export function markGpuSandboxOff(home: string, detail: string): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(
    gpuSandboxMarker(home),
    JSON.stringify({ since: new Date().toISOString(), detail }),
  );
}
