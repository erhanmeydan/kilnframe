// The FilmCraft control channel (storytold/filmcraft docs/control-protocol.md): one JSON request per line to
// 127.0.0.1:<port>, one JSON reply per line, every request carrying the shared token. FilmCraft only listens
// when it was started with --control and FILMCRAFT_CONTROL_TOKEN; the Kilnframe FilmCraft launcher does that
// and writes the port and token to ~/.kilnframe/filmcraft.json (mode 0600) for this client.
import { readFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export const NOT_RUNNING = "FILMCRAFT_NOT_RUNNING";

export interface FilmCraftClient {
  /** A control method (`engine.execute`, `ui.inspect`…); throws the reply's error when `ok` is false. */
  call(method: string, params?: unknown): Promise<unknown>;
  /** An engine command (`sequence.inspect`, `timeline.place`…) through `engine.execute`. */
  exec<T = unknown>(command: string, params?: unknown): Promise<T>;
  close(): void;
}

interface Endpoint {
  port: number;
  token: string;
}

export function readEndpoint(home = homedir()): Endpoint {
  try {
    const j = JSON.parse(
      readFileSync(join(home, ".kilnframe", "filmcraft.json"), "utf8"),
    ) as Endpoint;
    if (typeof j.port === "number" && /^[0-9a-f]{64}$/i.test(j.token)) return j;
  } catch {
    // no launcher file: FilmCraft was not started through the launcher
  }
  throw new Error(NOT_RUNNING);
}

/** Requests go one at a time over one connection, made again after FilmCraft closed it (idle, error). */
export function createFilmCraftClient(
  endpoint: () => Endpoint = () => readEndpoint(),
): FilmCraftClient {
  let socket: Socket | null = null;
  let buffer = "";
  let waiting: { ok: (line: string) => void; fail: (err: Error) => void } | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  let nextId = 1;

  function drop(err: Error) {
    socket?.destroy();
    socket = null;
    buffer = "";
    const w = waiting;
    waiting = null;
    w?.fail(err);
  }

  function connect(port: number): Promise<Socket> {
    return new Promise((ok, fail) => {
      const s = createConnection({ host: "127.0.0.1", port });
      s.setEncoding("utf8");
      s.once("connect", () => ok(s));
      s.once("error", () => fail(new Error(NOT_RUNNING)));
      s.on("data", (chunk: string) => {
        buffer += chunk;
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          const w = waiting;
          waiting = null;
          w?.ok(line);
        }
      });
      s.on("close", () => {
        if (socket === s) drop(new Error("FilmCraft closed the control connection"));
      });
    });
  }

  async function send(method: string, params: unknown): Promise<unknown> {
    const ep = endpoint();
    for (let attempt = 0; ; attempt++) {
      if (!socket) socket = await connect(ep.port);
      const s = socket;
      const id = nextId++;
      try {
        const line = await new Promise<string>((ok, fail) => {
          waiting = { ok, fail };
          s.write(JSON.stringify({ id, token: ep.token, method, params: params ?? {} }) + "\n");
        });
        const reply = JSON.parse(line) as { ok: boolean; result?: unknown; error?: string };
        if (!reply.ok)
          throw Object.assign(new Error(reply.error ?? "FilmCraft refused the request"), {
            fc: true,
          });
        return reply.result;
      } catch (err) {
        // a closed connection (FilmCraft drops idle ones after two minutes) is made again once
        if ((err as { fc?: boolean }).fc || attempt > 0) throw err;
        drop(err as Error);
      }
    }
  }

  return {
    call(method, params) {
      const run = chain.then(() => send(method, params));
      chain = run.catch(() => undefined);
      return run;
    },
    exec<T>(command: string, params?: unknown) {
      return this.call("engine.execute", { command, params: params ?? {} }) as Promise<T>;
    },
    close() {
      drop(new Error("closed"));
    },
  };
}
