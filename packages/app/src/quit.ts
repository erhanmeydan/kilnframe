// Quitting while a job runs: the companion and the job end with the app, so the job's work and the tokens it
// spent are lost. The menu's Quit and the macOS installer (preinstall asks the app to quit) come through
// before-quit, where the app asks instead. The Windows installer reads the marker file: it cannot wait for
// the app's question, so it asks the user to try again once the job is done.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface QuitState {
  /** The companion has a job running or waiting. */
  busy: boolean;
  /** The user chose Quit Now. */
  force: boolean;
  /** The computer is shutting down or logging out: never hold that up. */
  shuttingDown: boolean;
  /** The question is already on screen. */
  asking: boolean;
}

/** What a quit request does: quit now, ask the user first, or nothing while the question is open. */
export function onQuitRequest(s: QuitState): "quit" | "ask" | "wait" {
  if (!s.busy || s.force || s.shuttingDown) return "quit";
  return s.asking ? "wait" : "ask";
}

/** ~/.kilnframe/job-running: there while a job runs (the Windows installer checks it). */
export const jobMarker = (home: string) => join(home, "job-running");

export function markBusy(home: string, busy: boolean): void {
  if (!busy) {
    rmSync(jobMarker(home), { force: true });
    return;
  }
  mkdirSync(home, { recursive: true });
  writeFileSync(
    jobMarker(home),
    JSON.stringify({ pid: process.pid, since: new Date().toISOString() }),
  );
}
