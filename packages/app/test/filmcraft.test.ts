import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  filmCraftRunning,
  filmCraftState,
  findFilmCraft,
  freePort,
  launchFilmCraft,
  probeChannel,
} from "../src/filmcraft";

const MAC = "/Applications/FilmCraft.app/Contents/MacOS/FilmCraft";
const MAC_USER = "/Users/e/Applications/FilmCraft.app/Contents/MacOS/FilmCraft";

describe("findFilmCraft", () => {
  it("prefers /Applications, then ~/Applications, else null on a Mac", () => {
    expect(findFilmCraft("darwin", {}, () => true, "/Users/e")).toBe(MAC);
    expect(findFilmCraft("darwin", {}, (p) => p === MAC_USER, "/Users/e")).toBe(MAC_USER);
    expect(findFilmCraft("darwin", {}, () => false, "/Users/e")).toBeNull();
  });

  it("builds the Windows paths from the environment", () => {
    const env = { ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\e\\AppData\\Local" };
    const machine = "C:\\Program Files\\ArtCraft\\FilmCraft\\filmcraft.exe";
    const user = "C:\\Users\\e\\AppData\\Local\\Programs\\ArtCraft\\FilmCraft\\filmcraft.exe";
    expect(findFilmCraft("win32", env, (p) => p === machine, "C:\\Users\\e")).toBe(machine);
    expect(findFilmCraft("win32", env, (p) => p === user, "C:\\Users\\e")).toBe(user);
    expect(findFilmCraft("win32", env, () => false, "C:\\Users\\e")).toBeNull();
  });

  it("also finds the plain FilmCraft folder", () => {
    const env = { ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\L" };
    const plain = "C:\\Program Files\\FilmCraft\\FilmCraft.exe";
    expect(findFilmCraft("win32", env, (p) => p === plain, "C:\\Users\\e")).toBe(plain);
  });

  it("is null on other platforms", () => {
    expect(findFilmCraft("linux", {}, () => true, "/home/e")).toBeNull();
  });
});

describe("filmCraftState", () => {
  it("tells the four situations apart", () => {
    expect(filmCraftState(true, false, true)).toBe("open-without-kilnframe");
    expect(filmCraftState(true, true, true)).toBe("ours");
    expect(filmCraftState(false, false, true)).toBe("closed");
    expect(filmCraftState(false, false, false)).toBe("not-installed");
  });
});

describe("filmCraftRunning", () => {
  it("asks pgrep on a Mac", async () => {
    const calls: string[][] = [];
    const exec = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      return "123\n";
    };
    expect(await filmCraftRunning("darwin", exec)).toBe(true);
    expect(calls[0]).toEqual(["pgrep", "-x", "FilmCraft"]);
  });

  it("reads pgrep's failure (no match) as not running", async () => {
    const exec = async () => {
      throw new Error("exit 1");
    };
    expect(await filmCraftRunning("darwin", exec)).toBe(false);
  });

  it("asks tasklist on Windows and looks for the process in its output", async () => {
    const calls: string[][] = [];
    const found = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      return '"filmcraft.exe","4242","Console","1","80,000 K"\r\n';
    };
    expect(await filmCraftRunning("win32", found)).toBe(true);
    expect(calls[0]).toEqual([
      "tasklist",
      "/FI",
      "IMAGENAME eq FilmCraft.exe",
      "/FO",
      "CSV",
      "/NH",
    ]);
    const none = async () => "INFO: No tasks are running which match the specified criteria.\r\n";
    expect(await filmCraftRunning("win32", none)).toBe(false);
  });
});

describe("freePort", () => {
  it("gives a port nothing listens on", async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(0);
    const s = createServer();
    await new Promise<void>((ok) => s.listen(port, "127.0.0.1", ok));
    s.close();
  });
});

let servers: Server[] = [];
afterEach(() => {
  for (const s of servers) s.close();
  servers = [];
});

/** A fake FilmCraft channel on loopback that answers every line with `reply`. */
async function channel(reply: (req: Record<string, unknown>) => unknown) {
  const seen: Record<string, unknown>[] = [];
  const s = createServer((c) => {
    c.setEncoding("utf8");
    let buf = "";
    c.on("data", (d: string) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const req = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
        buf = buf.slice(nl + 1);
        seen.push(req);
        c.write(JSON.stringify(reply(req)) + "\n");
      }
    });
    c.on("error", () => undefined);
  });
  servers.push(s);
  const port = await new Promise<number>((ok) =>
    s.listen(0, "127.0.0.1", () => ok((s.address() as { port: number }).port)),
  );
  return { port, seen };
}

describe("probeChannel", () => {
  it("is true when ui.inspect answers ok with the token", async () => {
    const { port, seen } = await channel((r) => ({ id: r.id, ok: true, result: {} }));
    expect(await probeChannel(port, "tok")).toBe(true);
    expect(seen[0]).toMatchObject({ token: "tok", method: "ui.inspect" });
  });

  it("is false when the channel says no, and when nothing listens", async () => {
    const { port } = await channel((r) => ({ id: r.id, ok: false, error: "bad token" }));
    expect(await probeChannel(port, "tok")).toBe(false);
    const dead = await freePort();
    expect(await probeChannel(dead, "tok")).toBe(false);
  });
});

function fakeChild() {
  const c = new EventEmitter() as EventEmitter & { unref: () => void };
  c.unref = vi.fn();
  return c;
}

describe("launchFilmCraft", () => {
  it("gives the token only through the environment and detaches the child", async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const out = await launchFilmCraft(MAC, {
      spawn: spawn as never,
      port: async () => 4321,
      probe: async () => true,
      intervalMs: 1,
    });
    expect(out.port).toBe(4321);
    expect(out.token).toMatch(/^[0-9a-f]{64}$/);
    const [program, args, options] = spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string>; detached: boolean; stdio: string },
    ];
    expect(program).toBe(MAC);
    expect(args).toEqual(["--control", "4321"]);
    expect(args.join(" ")).not.toContain(out.token);
    expect(options.env.FILMCRAFT_CONTROL_TOKEN).toBe(out.token);
    expect(options.detached).toBe(true);
    expect(options.stdio).toBe("ignore");
    expect(child.unref).toHaveBeenCalled();
  });

  it("waits until the channel answers", async () => {
    let tries = 0;
    const out = await launchFilmCraft(MAC, {
      spawn: (() => fakeChild()) as never,
      port: async () => 1,
      probe: async () => ++tries >= 3,
      intervalMs: 1,
    });
    expect(out.port).toBe(1);
    expect(tries).toBe(3);
  });

  it("rejects when the channel stays silent, without the token in the message", async () => {
    let token = "";
    const err = await launchFilmCraft(MAC, {
      spawn: ((_p: string, _a: string[], o: { env: Record<string, string> }) => {
        token = o.env.FILMCRAFT_CONTROL_TOKEN;
        return fakeChild();
      }) as never,
      port: async () => 1,
      probe: async () => false,
      intervalMs: 2,
      timeoutMs: 30,
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/did not answer/);
    expect((err as Error).message).not.toContain(token);
  });

  it("rejects at once when the program cannot be started", async () => {
    const child = fakeChild();
    const p = launchFilmCraft(MAC, {
      spawn: (() => child) as never,
      port: async () => 1,
      probe: async () => false,
      intervalMs: 5,
      timeoutMs: 5000,
    });
    setTimeout(() => child.emit("error", new Error("spawn ENOENT")), 10);
    await expect(p).rejects.toThrow(/could not be started/);
  });
});
