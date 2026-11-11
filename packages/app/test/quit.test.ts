import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { jobMarker, markBusy, onQuitRequest, stopCompanion } from "../src/quit.js";

describe("onQuitRequest", () => {
  const idle = { busy: false, force: false, shuttingDown: false, asking: false };

  it("quits at once when no job runs", () => {
    expect(onQuitRequest(idle)).toBe("quit");
  });

  it("asks when a job runs, and waits while the question is open", () => {
    expect(onQuitRequest({ ...idle, busy: true })).toBe("ask");
    expect(onQuitRequest({ ...idle, busy: true, asking: true })).toBe("wait");
  });

  it("quits after Quit Now, and never holds up a shutdown", () => {
    expect(onQuitRequest({ ...idle, busy: true, force: true })).toBe("quit");
    expect(onQuitRequest({ ...idle, busy: true, shuttingDown: true })).toBe("quit");
  });
});

describe("markBusy", () => {
  it("writes the marker the installers read while a job runs, and removes it after", () => {
    const home = mkdtempSync(join(tmpdir(), "kilnframe-quit-"));
    markBusy(home, true);
    expect(JSON.parse(readFileSync(jobMarker(home), "utf8"))).toMatchObject({ pid: process.pid });
    markBusy(home, false);
    expect(existsSync(jobMarker(home))).toBe(false);
    // removing a marker that is not there is fine (startup clears a stale one)
    markBusy(home, false);
  });
});

describe("stopCompanion", () => {
  /** A stand-in for the companion process: `exits` says whether the quit message makes it exit. */
  function fake(exits: "quit" | "never") {
    const emitter = new EventEmitter();
    const child = Object.assign(emitter, {
      pid: 4242,
      connected: true,
      exitCode: null as number | null,
      signalCode: null,
      sent: [] as unknown[],
      send(m: unknown) {
        child.sent.push(m);
        if (exits === "quit")
          setTimeout(() => {
            child.exitCode = 0;
            emitter.emit("exit", 0);
          }, 20);
        return true;
      },
    });
    return child;
  }

  it("asks the companion to quit, so it can end its job, and waits for it", async () => {
    const child = fake("quit");
    const killed: number[] = [];
    await stopCompanion(child, { waitMs: 1000, killTree: (pid) => killed.push(pid) });
    expect(child.sent).toEqual([{ type: "quit" }]);
    expect(killed).toEqual([]);
  });

  it("ends the whole tree when the companion does not quit in time", async () => {
    const child = fake("never");
    const killed: number[] = [];
    await stopCompanion(child, { waitMs: 50, killTree: (pid) => killed.push(pid) });
    expect(killed).toEqual([4242]);
  });

  it("ends the tree at once when the channel is already closed", async () => {
    const child = Object.assign(fake("never"), { connected: false });
    const killed: number[] = [];
    await stopCompanion(child, { waitMs: 5000, killTree: (pid) => killed.push(pid) });
    expect(child.sent).toEqual([]);
    expect(killed).toEqual([4242]);
  });
});
