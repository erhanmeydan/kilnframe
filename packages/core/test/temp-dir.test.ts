import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { removeTempDir } from "../src/temp-dir.js";

describe("removeTempDir", () => {
  it("removes the folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "kf-temp-test-"));
    writeFileSync(join(dir, "a.txt"), "x");
    removeTempDir(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it("retries and never throws when Windows holds the folder", () => {
    let options: unknown;
    const held = ((_: string, o: unknown) => {
      options = o;
      throw Object.assign(new Error("EPERM, Permission denied"), { code: "EPERM" });
    }) as never;
    expect(() => removeTempDir("C:\\Temp\\mi-claude-UM82EK", held)).not.toThrow();
    expect(options).toMatchObject({ recursive: true, force: true, maxRetries: 5 });
  });
});
