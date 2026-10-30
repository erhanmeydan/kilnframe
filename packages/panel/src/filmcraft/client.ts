// The FilmCraft control channel (storytold/filmcraft docs/control-protocol.md): one JSON request per line to
// 127.0.0.1:<port>, one JSON reply per line with the request's id, every request carrying the shared token.
// FilmCraft only listens when it was started with --control and FILMCRAFT_CONTROL_TOKEN; the Kilnframe app does
// that and keeps the port and token in memory, so a FilmCraft it did not start (or started before it restarted)
// reads as not running. The token never goes into an error message or a log.
import { createConnection, type Socket } from "node:net";
import { NOT_RUNNING } from "../resolve/api";

export { NOT_RUNNING };

export interface Endpoint {
  port: number;
  token: string;
}

export interface FilmCraftClient {
  /** A control method (`engine.execute`, `ui.inspect`…); throws the reply's error when `ok` is false. */
  call(method: string, params?: unknown): Promise<unknown>;
  /** An engine command (`sequence.inspect`, `timeline.place`…) through `engine.execute`. */
  exec<T = unknown>(command: string, params?: unknown): Promise<T>;
  close(): void;
}

interface Reply {
  id?: unknown;
  ok?: boolean;
  result?: unknown;
  error?: string;
}

/** FilmCraft answered, and said no: never sent again. */
class Refused extends Error {}

/**
 * Requests go one at a time over one connection, made again after FilmCraft closed it (it drops connections
 * idle for two minutes, and after an error reply). `endpoint` is null when FilmCraft is not running.
 */
export function createFilmCraftClient(endpoint: () => Endpoint | null): FilmCraftClient {
  let socket: Socket | null = null;
  let socketPort = 0;
  let buffer = "";
  let waiting: { id: number; ok: (reply: Reply) => void; fail: (err: Error) => void } | null = null;
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

  function take(line: string) {
    let reply: Reply;
    try {
      reply = JSON.parse(line) as Reply;
    } catch {
      return;
    }
    const w = waiting;
    // a reply for another request is passed over; an error without an id is FilmCraft refusing the request
    // before reading it (a bad token), closing the connection after it
    if (!w || (reply.id !== w.id && !(reply.id === undefined && reply.ok === false))) return;
    waiting = null;
    w.ok(reply);
  }

  function connect(port: number): Promise<Socket> {
    return new Promise((ok, fail) => {
      const s = createConnection({ host: "127.0.0.1", port });
      s.setEncoding("utf8");
      s.once("connect", () => ok(s));
      // every error ends in "close"; before the connection is made it means nothing listens on the port
      s.on("error", () => fail(new Error(NOT_RUNNING)));
      s.on("data", (chunk: string) => {
        if (socket !== s) return;
        buffer += chunk;
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          take(line);
        }
      });
      s.on("close", () => {
        if (socket === s) drop(new Error("FilmCraft closed the control connection"));
      });
    });
  }

  async function send(method: string, params: unknown): Promise<unknown> {
    const ep = endpoint();
    if (!ep) throw new Error(NOT_RUNNING);
    // FilmCraft started again on another port: the old connection leads nowhere
    if (socket && socketPort !== ep.port) drop(new Error("closed"));
    for (let attempt = 0; ; attempt++) {
      if (!socket) {
        socket = await connect(ep.port);
        socketPort = ep.port;
      }
      const s = socket;
      const id = nextId++;
      try {
        const reply = await new Promise<Reply>((ok, fail) => {
          waiting = { id, ok, fail };
          s.write(JSON.stringify({ id, token: ep.token, method, params: params ?? {} }) + "\n");
        });
        if (!reply.ok) throw new Refused(reply.error ?? "FilmCraft refused the request");
        return reply.result;
      } catch (err) {
        // a connection FilmCraft closed is made again once; when FilmCraft has quit, that says NOT_RUNNING
        if (err instanceof Refused || attempt > 0) throw err;
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
