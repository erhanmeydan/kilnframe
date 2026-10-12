import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readConnection } from "../src/companion";
import { homeDir, homeDirNow, isWindows } from "../src/home";
import { host, setHost, type Host } from "../src/host";

describe("host", () => {
  it("throws a clear error when no host was installed", () => {
    expect(() => host()).toThrow(/no host/i);
  });
  it("returns the installed host", () => {
    const fake = { kind: "premiere" } as Host;
    setHost(fake);
    expect(host()).toBe(fake);
  });
});

describe("home through the host", () => {
  it("waits while the host has no home folder yet (UXP while the panel loads)", async () => {
    let home: string | null = null;
    setHost({ kind: "premiere", homedir: () => home, platform: () => "mac" } as unknown as Host);
    setTimeout(() => (home = "/Users/e"), 300);
    await expect(homeDir(2000)).resolves.toBe("/Users/e");
    expect(homeDirNow()).toBe("/Users/e");
  });
  it("asks the host for the platform", () => {
    setHost({
      kind: "premiere",
      homedir: () => "C:/Users/e",
      platform: () => "win",
    } as unknown as Host);
    expect(isWindows()).toBe(true);
  });
});

describe("companion file through the host", () => {
  it("reads companion.json with the host", async () => {
    const read: string[] = [];
    setHost({
      kind: "premiere",
      homedir: () => "/Users/e",
      platform: () => "mac",
      readTextFile: async (p: string) => {
        read.push(p);
        return '{"port":47615,"token":"x","version":"0.1.2"}';
      },
    } as unknown as Host);
    await expect(readConnection()).resolves.toEqual({ port: 47615, token: "x", version: "0.1.2" });
    expect(read).toEqual(["/Users/e/.kilnframe/companion.json"]);
  });
});

describe("only the host touches the editor", () => {
  const dir = join(__dirname, "..", "src");
  it("no panel source file outside host-premiere.ts calls require()", () => {
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !["host-premiere.ts", "globals.d.ts"].includes(f))
      .filter((f) => /\brequire\(/.test(readFileSync(join(dir, f), "utf8")));
    expect(offenders).toEqual([]);
  });
  it("premiere.ts is gone", () => {
    expect(readdirSync(dir)).not.toContain("premiere.ts");
  });
});
