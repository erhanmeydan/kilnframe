import { describe, expect, it } from "vitest";
import { createFilmCraftOpener, filmCraftMenuItems } from "../src/filmcraft.js";
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

describe("Open FilmCraft", () => {
  const ep = { port: 4321, token: "t" };
  const setup = (o: {
    running: boolean;
    answers?: "ok" | "refused" | "no-answer";
    launch?: () => Promise<typeof ep>;
  }) => {
    const calls: string[] = [];
    let running = o.running;
    const opener = createFilmCraftOpener({
      program: () => "/Applications/FilmCraft.app/Contents/MacOS/FilmCraft",
      running: async () => running,
      answers: async () => o.answers ?? "ok",
      launch: async (program) => {
        calls.push(`launch ${program}`);
        const r = await (o.launch ?? (async () => ep))();
        running = true;
        return r;
      },
      showPanel: () => calls.push("panel"),
      openWithoutKilnframe: () => calls.push("warn"),
      failed: (err) => calls.push(`failed ${err.message}`),
    });
    return { opener, calls };
  };

  it("is offered only when FilmCraft is installed", () => {
    const click = () => undefined;
    expect(filmCraftMenuItems(null, "Open FilmCraft", click)).toEqual([]);
    expect(filmCraftMenuItems("/x/FilmCraft", "Open FilmCraft", click)).toEqual([
      { label: "Open FilmCraft", click },
    ]);
  });

  it("starts a closed FilmCraft, keeps its endpoint and opens the panel", async () => {
    const { opener, calls } = setup({ running: false });
    expect(opener.endpoint()).toBeNull();
    await opener.open();
    expect(calls).toEqual(["launch /Applications/FilmCraft.app/Contents/MacOS/FilmCraft", "panel"]);
    expect(opener.endpoint()).toEqual(ep);
  });

  it("only brings the panel forward when FilmCraft is already ours", async () => {
    const { opener, calls } = setup({ running: false });
    await opener.open();
    calls.length = 0;
    await opener.open();
    expect(calls).toEqual(["panel"]);
  });

  it("never touches a FilmCraft opened without Kilnframe", async () => {
    const { opener, calls } = setup({ running: true });
    await opener.open();
    expect(calls).toEqual(["warn"]);
    expect(opener.endpoint()).toBeNull();
  });

  it("does not take a FilmCraft opened by hand on its old port for its own", async () => {
    const { opener, calls } = setup({ running: false, answers: "refused" });
    await opener.open();
    calls.length = 0;
    await opener.open();
    expect(calls).toEqual(["warn"]);
    expect(opener.endpoint()).toBeNull();
  });

  it("keeps a busy FilmCraft that does not answer in time for its own", async () => {
    const { opener, calls } = setup({ running: false, answers: "no-answer" });
    await opener.open();
    calls.length = 0;
    await opener.open();
    expect(calls).toEqual(["panel"]);
    expect(opener.endpoint()).toEqual(ep);
  });

  it("says when FilmCraft could not be started, without opening the panel", async () => {
    const { opener, calls } = setup({
      running: false,
      launch: async () => {
        throw new Error("no answer");
      },
    });
    await opener.open();
    expect(calls.slice(1)).toEqual(["failed no answer"]);
    expect(opener.endpoint()).toBeNull();
  });

  it("starts FilmCraft once when the menu is clicked twice", async () => {
    let finish: (e: typeof ep) => void = () => undefined;
    const { opener, calls } = setup({
      running: false,
      launch: () => new Promise((ok) => (finish = ok)),
    });
    const first = opener.open();
    const second = opener.open();
    await new Promise((r) => setTimeout(r, 0));
    finish(ep);
    await Promise.all([first, second]);
    expect(calls.filter((c) => c.startsWith("launch"))).toHaveLength(1);
  });
});
