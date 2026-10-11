import { describe, expect, it } from "vitest";
import { installArgs, needsInstall, removeArgs, replacesSameVersion } from "../src/plugin.js";
import { companionPath } from "../src/shell-path.js";

describe("companionPath", () => {
  it("puts the login shell's PATH first, so the agents in the user's home are found", () => {
    const path = companionPath(
      "/usr/bin:/bin",
      "darwin",
      () => "/Users/e/.local/bin:/usr/bin",
      "/nowhere",
    );
    // Homebrew's folders follow when they exist on the computer running the test
    expect(path.split(":").slice(0, 3)).toEqual(["/Users/e/.local/bin", "/usr/bin", "/bin"]);
  });

  it("keeps the current PATH when the shell cannot be read", () => {
    expect(companionPath("/usr/bin:/bin", "darwin", () => null, "/nowhere")).toMatch(
      /^\/usr\/bin:\/bin(:|$)/,
    );
  });

  it("leaves Windows alone", () => {
    expect(companionPath("C:\\a;C:\\b", "win32", () => "/x")).toBe("C:\\a;C:\\b");
  });
});

describe("needsInstall", () => {
  const plugin = { id: "kilnframe", version: "0.2.0", hash: "abc" };
  it("installs when nothing, another version or another build was installed", () => {
    expect(needsInstall(plugin, undefined)).toBe(true);
    expect(needsInstall(plugin, { id: "kilnframe", version: "0.1.0", hash: "abc" })).toBe(true);
    expect(needsInstall(plugin, { id: "kilnframe-test", version: "0.2.0", hash: "abc" })).toBe(
      true,
    );
    expect(needsInstall(plugin, { id: "kilnframe", version: "0.2.0", hash: "old" })).toBe(true);
    expect(needsInstall(plugin, { id: "kilnframe", version: "0.2.0" })).toBe(true);
  });
  it("skips the build it installed last", () => {
    expect(needsInstall(plugin, { id: "kilnframe", version: "0.2.0", hash: "abc" })).toBe(false);
  });
});

describe("installArgs", () => {
  it("speaks each platform's form of Adobe's installer", () => {
    expect(installArgs("k.ccx", "darwin")).toEqual(["--install", "k.ccx"]);
    expect(installArgs("C:\\k.ccx", "win32")).toEqual(["/install", "C:\\k.ccx"]);
  });
});

describe("replacing a plugin of the same version", () => {
  const bundled = { id: "kilnframe", version: "0.1.2", hash: "new" };

  it("removes first only when the same version, built differently, is installed", () => {
    // Adobe's agent leaves an installed version in place and still says it installed
    expect(replacesSameVersion(bundled, { id: "kilnframe", version: "0.1.2", hash: "old" })).toBe(
      true,
    );
    expect(replacesSameVersion(bundled, { id: "kilnframe", version: "0.1.1", hash: "old" })).toBe(
      false,
    );
    expect(replacesSameVersion(bundled, undefined)).toBe(false);
  });

  it("removes by the name Creative Cloud lists", () => {
    expect(removeArgs("Kilnframe", "darwin")).toEqual(["--remove", "Kilnframe"]);
    expect(removeArgs("Kilnframe", "win32")).toEqual(["/remove", "Kilnframe"]);
  });
});
