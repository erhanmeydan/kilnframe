// The FilmCraft control channel (storytold/filmcraft docs/control-protocol.md): one JSON request per line to
// 127.0.0.1:<port>, one JSON reply per line with the request's id, every request carrying the shared token.
// FilmCraft only listens when it was started with --control and FILMCRAFT_CONTROL_TOKEN; the Kilnframe app does
// that and keeps the port and token in memory, so a FilmCraft it did not start (or started before it restarted)
// reads as not running. The token never goes into an error message or a log.
import { createConnection, type Socket } from "node:net";
import { NOT_RUNNING } from "../resolve/api";

export { NOT_RUNNING };
/** The connection closed after the request went out: FilmCraft may or may not have done it. */
export const CONNECTION_LOST = "FILMCRAFT_CONNECTION_LOST";
/** No reply in time; the connection is closed so the requests after it can go. */
export const TIMED_OUT = "FILMCRAFT_TIMED_OUT";

/** How long a request waits for its reply unless it says otherwise. */
export const REPLY_LIMIT_MS = 30_000;

export interface Endpoint {
  port: number;
  token: string;
}

export interface CallOptions {
  /** Milliseconds to wait for the reply; null waits as long as it takes. */
  timeoutMs?: number | null;
  /**
   * Sent on a connection of its own, not behind the requests waiting on the shared one: a stop that has to
   * reach FilmCraft while an export holds the shared connection.
   */
  alone?: boolean;
}

export interface FilmCraftClient {
  /** A control method (`engine.execute`, `ui.inspect`…); throws the reply's error when `ok` is false. */
  call(method: string, params?: unknown, opts?: CallOptions): Promise<unknown>;
  /** An engine command (`sequence.inspect`, `timeline.place`…) through `engine.execute`. */
  exec<T = unknown>(command: string, params?: unknown, opts?: CallOptions): Promise<T>;
  close(): void;
}

interface Reply {
  id?: unknown;
  ok?: boolean;
  result?: unknown;
  error?: string;
}

/** FilmCraft answered, and said no. */
class Refused extends Error {}

const lineOf = (id: number, ep: Endpoint, method: string, params: unknown) =>
  JSON.stringify({ id, token: ep.token, method, params: params ?? {} }) + "\n";

/** The reply for request `id`; an error without an id is FilmCraft refusing a request before reading it. */
function replyFor(line: string, id: number): Reply | null {
  try {
    const reply = JSON.parse(line) as Reply;
    if (reply.id === id || (reply.id === undefined && reply.ok === false)) return reply;
  } catch {
    // not a reply line
  }
  return null;
}

/** A connection that hands over each line and says once that it is gone (closed, ended or failed). */
function open(
  port: number,
  onLine: (line: string) => void,
  onGone: (s: Socket) => void,
): Promise<Socket> {
  return new Promise((ok, fail) => {
    const s = createConnection({ host: "127.0.0.1", port });
    let buffer = "";
    s.setEncoding("utf8");
    s.once("connect", () => ok(s));
    // before the connection is made, any error means nothing listens on the port
    s.on("error", () => fail(new Error(NOT_RUNNING)));
    s.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        onLine(line);
      }
    });
    s.on("end", () => onGone(s));
    s.on("close", () => onGone(s));
  });
}

/** After a connection broke under a request: FilmCraft gone (NOT_RUNNING) or still there (CONNECTION_LOST). */
async function lostOn(port: number): Promise<Error> {
  try {
    (
      await open(
        port,
        () => undefined,
        () => undefined,
      )
    ).destroy();
    return new Error(CONNECTION_LOST);
  } catch {
    return new Error(NOT_RUNNING);
  }
}

/** Waits for `reply`, failing with TIMED_OUT after `ms` (null: no limit) after `onTimeout` ran. */
function withLimit<T>(reply: Promise<T>, ms: number | null, onTimeout: () => void): Promise<T> {
  if (ms === null) return reply;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, fail) => {
    timer = setTimeout(() => {
      onTimeout();
      fail(new Error(TIMED_OUT));
    }, ms);
  });
  return Promise.race([reply, limit]).finally(() => clearTimeout(timer));
}

/**
 * Requests go one at a time over one connection. A connection FilmCraft closed while idle (it drops ones idle
 * for two minutes, and after an error reply) is made again; a request already sent is never sent again, since
 * FilmCraft may have done it. `endpoint` is null when FilmCraft is not running.
 */
export function createFilmCraftClient(
  endpoint: () => Endpoint | null,
  opts: { timeoutMs?: number } = {},
): FilmCraftClient {
  const defaultLimit = opts.timeoutMs ?? REPLY_LIMIT_MS;
  let socket: Socket | null = null;
  let socketPort = 0;
  let waiting: { take: (line: string) => void; fail: (err: Error) => void } | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  let nextId = 1;

  function drop(err: Error) {
    socket?.destroy();
    socket = null;
    const w = waiting;
    waiting = null;
    w?.fail(err);
  }

  async function send(method: string, params: unknown, limit: number | null): Promise<unknown> {
    const ep = endpoint();
    if (!ep) throw new Error(NOT_RUNNING);
    // FilmCraft started again on another port, or the connection is already gone: made again before writing
    if (socket && (socketPort !== ep.port || socket.destroyed || !socket.writable))
      drop(new Error(CONNECTION_LOST));
    if (!socket) {
      socket = await open(
        ep.port,
        (line) => waiting?.take(line),
        (s) => {
          if (socket === s) drop(new Error(CONNECTION_LOST));
        },
      );
      socketPort = ep.port;
    }
    const s = socket;
    const id = nextId++;
    let reply: Reply;
    try {
      reply = await withLimit(
        new Promise<Reply>((ok, fail) => {
          waiting = {
            take(line) {
              const r = replyFor(line, id);
              if (!r) return;
              waiting = null;
              ok(r);
            },
            fail,
          };
          s.write(lineOf(id, ep, method, params));
        }),
        limit,
        () => {
          if (socket === s) drop(new Error(TIMED_OUT));
        },
      );
    } catch (err) {
      if ((err as Error).message === TIMED_OUT) throw err;
      throw await lostOn(ep.port);
    }
    if (!reply.ok) throw new Refused(reply.error ?? "FilmCraft refused the request");
    return reply.result;
  }

  /** One request on a connection of its own, closed after the reply. */
  async function sendAlone(method: string, params: unknown, limit: number | null) {
    const ep = endpoint();
    if (!ep) throw new Error(NOT_RUNNING);
    const id = 1;
    let take: (line: string) => void = () => undefined;
    let gone: () => void = () => undefined;
    const s = await open(
      ep.port,
      (line) => take(line),
      () => gone(),
    );
    try {
      const reply = await withLimit(
        new Promise<Reply>((ok, fail) => {
          take = (line) => {
            const r = replyFor(line, id);
            if (r) ok(r);
          };
          gone = () => fail(new Error(CONNECTION_LOST));
          s.write(lineOf(id, ep, method, params));
        }),
        limit,
        () => undefined,
      );
      if (!reply.ok) throw new Refused(reply.error ?? "FilmCraft refused the request");
      return reply.result;
    } finally {
      s.destroy();
    }
  }

  return {
    call(method, params, o = {}) {
      const limit = o.timeoutMs === undefined ? defaultLimit : o.timeoutMs;
      if (o.alone) return sendAlone(method, params, limit);
      const run = chain.then(() => send(method, params, limit));
      chain = run.catch(() => undefined);
      return run;
    },
    exec<T>(command: string, params?: unknown, o?: CallOptions) {
      return this.call("engine.execute", { command, params: params ?? {} }, o) as Promise<T>;
    },
    close() {
      drop(new Error("closed"));
    },
  };
}
