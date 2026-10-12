import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { kilnframeFile } from "../src/resolve/paths";

function home() {
  const h = mkdtempSync(join(tmpdir(), "kf-home-"));
  mkdirSync(join(h, ".kilnframe"), { recursive: true });
  mkdirSync(join(h, "Library", "LaunchAgents"), { recursive: true });
  return h;
}

describe("resolve panel file access", () => {
  it("allows Kilnframe's own folder: the connection file and the panel log", () => {
    const h = home();
    expect(kilnframeFile(join(h, ".kilnframe", "companion.json"), h)).toBe(
      join(h, ".kilnframe", "companion.json"),
    );
    expect(kilnframeFile(join(h, ".kilnframe", "new", "panel-log.txt"), h)).toBe(
      join(h, ".kilnframe", "new", "panel-log.txt"),
    );
  });

  it("refuses the rest of the home folder and tricks with ..", () => {
    const h = home();
    expect(() => kilnframeFile(join(h, "Library", "LaunchAgents", "x.plist"), h)).toThrow();
    expect(() => kilnframeFile(join(h, ".zshrc"), h)).toThrow();
    expect(() => kilnframeFile(join(h, ".kilnframe", "..", ".zshrc"), h)).toThrow();
    expect(() => kilnframeFile(join(h, ".kilnframe-evil", "a"), h)).toThrow();
  });

  it("refuses a symlink inside Kilnframe's folder that points elsewhere", () => {
    const h = home();
    symlinkSync(join(h, "Library", "LaunchAgents"), join(h, ".kilnframe", "out"));
    expect(() => kilnframeFile(join(h, ".kilnframe", "out", "x.plist"), h)).toThrow();
  });
});
