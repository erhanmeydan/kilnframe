import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  gpuSandboxMarker,
  gpuSandboxOff,
  markGpuSandboxOff,
  onChildGone,
} from "../src/gpu-sandbox.js";

describe("onChildGone", () => {
  const crash = {
    platform: "win32" as NodeJS.Platform,
    type: "GPU",
    reason: "crashed",
    marked: false,
    busy: false,
  };

  it("restarts at once without the sandbox when the GPU process crashes on Windows", () => {
    expect(onChildGone(crash)).toBe("relaunch");
    expect(onChildGone({ ...crash, reason: "launch-failed" })).toBe("relaunch");
  });

  it("only marks it while a job runs, so the job is not ended", () => {
    expect(onChildGone({ ...crash, busy: true })).toBe("mark");
  });

  it("leaves other processes, other endings, macOS and an already marked computer alone", () => {
    expect(onChildGone({ ...crash, type: "Utility" })).toBe("none");
    expect(onChildGone({ ...crash, reason: "clean-exit" })).toBe("none");
    expect(onChildGone({ ...crash, reason: "killed" })).toBe("none");
    expect(onChildGone({ ...crash, platform: "darwin" })).toBe("none");
    expect(onChildGone({ ...crash, marked: true })).toBe("none");
  });
});

describe("the marker", () => {
  it("turns the sandbox off on the next Windows start only", () => {
    const home = mkdtempSync(join(tmpdir(), "kf-gpu-"));
    expect(gpuSandboxOff("win32", home)).toBe(false);
    markGpuSandboxOff(home, "crashed -1073741819");
    expect(existsSync(gpuSandboxMarker(home))).toBe(true);
    expect(JSON.parse(readFileSync(gpuSandboxMarker(home), "utf8")).detail).toBe(
      "crashed -1073741819",
    );
    expect(gpuSandboxOff("win32", home)).toBe(true);
    expect(gpuSandboxOff("darwin", home)).toBe(false);
  });
});
