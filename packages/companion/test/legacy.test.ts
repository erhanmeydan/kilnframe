import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryKeyStore } from "../src/keys.js";
import { copyLegacyKeys, moveLegacyFolders } from "../src/legacy.js";

describe("data kept under the old name", () => {
  it("moves the settings folder and the model cache, once", () => {
    const home = mkdtempSync(join(tmpdir(), "mi-home-"));
    mkdirSync(join(home, ".motion-insert", "styles"), { recursive: true });
    writeFileSync(join(home, ".motion-insert", "styles", "mine.md"), "x");
    mkdirSync(join(home, ".cache", "motion-insert", "models"), { recursive: true });
    expect(moveLegacyFolders(home)).toEqual([
      join(home, ".kilnframe"),
      join(home, ".cache", "kilnframe"),
    ]);
    expect(existsSync(join(home, ".kilnframe", "styles", "mine.md"))).toBe(true);
    expect(existsSync(join(home, ".motion-insert"))).toBe(false);
    expect(moveLegacyFolders(home)).toEqual([]);
  });

  it("leaves a new folder alone when both exist", () => {
    const home = mkdtempSync(join(tmpdir(), "mi-home-"));
    mkdirSync(join(home, ".motion-insert"));
    mkdirSync(join(home, ".kilnframe"));
    expect(moveLegacyFolders(home)).toEqual([]);
    expect(existsSync(join(home, ".motion-insert"))).toBe(true);
  });

  it("copies keys the new service lacks and keeps the old ones", async () => {
    const old = new MemoryKeyStore();
    const now = new MemoryKeyStore();
    await old.set("gemini", "g-old");
    await old.set("xai", "x-old");
    await now.set("xai", "x-new");
    const home = mkdtempSync(join(tmpdir(), "mi-home-"));
    expect(
      await copyLegacyKeys(old, now, ["gemini", "xai", "minimax"], join(home, ".kilnframe")),
    ).toEqual(["gemini"]);
    expect(await now.get("gemini")).toBe("g-old");
    expect(await now.get("xai")).toBe("x-new");
    expect(await old.get("gemini")).toBe("g-old");
  });

  it("copies the keys only once, so a key deleted in the settings stays deleted", async () => {
    const home = mkdtempSync(join(tmpdir(), "mi-home-"));
    const old = new MemoryKeyStore();
    const now = new MemoryKeyStore();
    await old.set("gemini", "g-old");
    expect(await copyLegacyKeys(old, now, ["gemini"], join(home, ".kilnframe"))).toEqual([
      "gemini",
    ]);
    await now.delete("gemini");
    expect(await copyLegacyKeys(old, now, ["gemini"], join(home, ".kilnframe"))).toEqual([]);
    expect(await now.get("gemini")).toBeUndefined();
  });

  it("tries the copy again next start when the old keychain could not be read", async () => {
    const home = mkdtempSync(join(tmpdir(), "mi-home-"));
    const now = new MemoryKeyStore();
    const declined = {
      get: async () => {
        throw new Error("keychain prompt declined");
      },
      set: async () => {},
      delete: async () => false,
    };
    expect(await copyLegacyKeys(declined, now, ["gemini"], join(home, ".kilnframe"))).toEqual([]);
    const old = new MemoryKeyStore();
    await old.set("gemini", "g-old");
    expect(await copyLegacyKeys(old, now, ["gemini"], join(home, ".kilnframe"))).toEqual([
      "gemini",
    ]);
  });

  it("does not take a deleted key as a reason to try again", async () => {
    const home = mkdtempSync(join(tmpdir(), "mi-home-"));
    expect(existsSync(join(home, ".kilnframe", "legacy-keys-copied"))).toBe(false);
    await copyLegacyKeys(
      new MemoryKeyStore(),
      new MemoryKeyStore(),
      ["gemini"],
      join(home, ".kilnframe"),
    );
    expect(existsSync(join(home, ".kilnframe", "legacy-keys-copied"))).toBe(true);
  });
});
