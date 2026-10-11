import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { jobMarker, markBusy, onQuitRequest } from "../src/quit.js";

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
