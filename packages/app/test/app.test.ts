import { describe, expect, it } from "vitest";
import { createFilmCraftOpener, filmCraftMenuItems, quitFilmCraft } from "../src/filmcraft.js";
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
    /** The answer to the close-and-reopen question. */
    reopen?: boolean;
    /** Whether FilmCraft quits when asked (false: the user cancelled its save prompt). */
    quits?: boolean;
    /** The quit request itself failed (taskkill error, Apple events not allowed). */
    quitRefused?: boolean;
    /** How long FilmCraft takes to quit after the request (ms). */
    quitAfterMs?: number;
    closeLimitMs?: number;
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
      askToReopen: async () => {
        calls.push("ask");
        return o.reopen ?? false;
      },
      quit: async () => {
        calls.push("quit");
        if (o.quitRefused) return "refused";
        if (o.quits ?? true) setTimeout(() => (running = false), o.quitAfterMs ?? 5);
        return "sent";
      },
      stayedOpen: () => calls.push("stayed open"),
      pollMs: 1,
      closeLimitMs: o.closeLimitMs ?? 50,
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

  it("asks before touching a FilmCraft opened without Kilnframe, and leaves it on Cancel", async () => {
    const { opener, calls } = setup({ running: true, reopen: false });
    await opener.open();
    expect(calls).toEqual(["ask"]);
    expect(opener.endpoint()).toBeNull();
  });

  it("closes and reopens it with the channel when the user agrees", async () => {
    const { opener, calls } = setup({ running: true, reopen: true });
    await opener.open();
    expect(calls).toEqual([
      "ask",
      "quit",
      "launch /Applications/FilmCraft.app/Contents/MacOS/FilmCraft",
      "panel",
    ]);
    expect(opener.endpoint()).toEqual(ep);
  });

  it("starts nothing when FilmCraft stays open (its save prompt cancelled)", async () => {
    const { opener, calls } = setup({ running: true, reopen: true, quits: false });
    await opener.open();
    expect(calls).toEqual(["ask", "quit", "stayed open"]);
    expect(opener.endpoint()).toBeNull();
  });

  it("says at once that FilmCraft stayed open when the quit request fails", async () => {
    const { opener, calls } = setup({
      running: true,
      reopen: true,
      quitRefused: true,
      closeLimitMs: 60_000,
    });
    const started = Date.now();
    await opener.open();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(calls).toEqual(["ask", "quit", "stayed open"]);
  });

  it("keeps waiting while FilmCraft's save prompt holds the quit", async () => {
    // the request was sent (osascript ran into its time limit); FilmCraft quits later
    const { opener, calls } = setup({ running: true, reopen: true, quitAfterMs: 30 });
    await opener.open();
    expect(calls).toEqual([
      "ask",
      "quit",
      "launch /Applications/FilmCraft.app/Contents/MacOS/FilmCraft",
      "panel",
    ]);
  });

  it("asks once when the menu is clicked again during the question", async () => {
    const { opener, calls } = setup({ running: true, reopen: false });
    await Promise.all([opener.open(), opener.open()]);
    expect(calls).toEqual(["ask"]);
  });

  it("does not take a FilmCraft opened by hand on its old port for its own", async () => {
    const { opener, calls } = setup({ running: false, answers: "refused" });
    await opener.open();
    calls.length = 0;
    await opener.open();
    expect(calls).toEqual(["ask"]);
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

describe("quitFilmCraft", () => {
  const record = () => {
    const calls: string[][] = [];
    const exec = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      return "";
    };
    return { calls, exec };
  };

  it("asks FilmCraft to quit on a Mac, so it can offer to save", async () => {
    const { calls, exec } = record();
    await quitFilmCraft("darwin", exec);
    expect(calls).toEqual([["osascript", "-e", 'tell application "FilmCraft" to quit']]);
  });

  it("closes it on Windows without forcing (no /F)", async () => {
    const { calls, exec } = record();
    await quitFilmCraft("win32", exec);
    // image names are matched without regard to case: FilmCraft.exe and filmcraft.exe alike
    expect(calls).toEqual([["taskkill", "/IM", "filmcraft.exe"]]);
  });

  it("says sent when the request went out, also when a save prompt outlasts osascript's time limit", async () => {
    const { exec } = record();
    expect(await quitFilmCraft("darwin", exec)).toBe("sent");
    expect(await quitFilmCraft("win32", exec)).toBe("sent");
    const timedOut = async () => {
      // execFile's timeout kills the child and reports it as killed
      throw Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM" });
    };
    expect(await quitFilmCraft("darwin", timedOut)).toBe("sent");
  });

  it("says refused, without throwing, when the request itself fails", async () => {
    const notAllowed = async () => {
      throw Object.assign(new Error("Not authorized to send Apple events (-1743)"), { code: 1 });
    };
    expect(await quitFilmCraft("darwin", notAllowed)).toBe("refused");
    expect(await quitFilmCraft("win32", notAllowed)).toBe("refused");
  });
});
