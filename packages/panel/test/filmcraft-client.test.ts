import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONNECTION_LOST,
  createFilmCraftClient,
  NOT_RUNNING,
  TIMED_OUT,
  type FilmCraftClient,
} from "../src/filmcraft/client";

const TOKEN = "ab".repeat(32);

interface Request {
  id: number;
  token: string;
  method: string;
  params: { command?: string; params?: unknown };
}

/** A control channel on a random port; `answer` gets each request and the connection it came on. */
async function serve(answer: (req: Request, socket: Socket, n: number) => void) {
  const requests: Request[] = [];
  let connections = 0;
  /** Resolves once a connection has closed at both ends (the client saw it go). */
  let closed: () => void = () => undefined;
  const sockets: Socket[] = [];
  const server: Server = createServer((socket) => {
    connections++;
    sockets.push(socket);
    socket.on("close", () => closed());
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const req = JSON.parse(buffer.slice(0, nl)) as Request;
        buffer = buffer.slice(nl + 1);
        requests.push(req);
        answer(req, socket, requests.length);
      }
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  servers.push(server);
  return {
    port,
    server,
    requests,
    connections: () => connections,
    /** FilmCraft closes every connection it has. */
    endAll: () => sockets.forEach((x) => x.end()),
    nextClose: () => new Promise<void>((ok) => (closed = ok)),
  };
}

const reply = (socket: Socket, body: object) => socket.write(JSON.stringify(body) + "\n");

const servers: Server[] = [];
const clients: FilmCraftClient[] = [];
const client = (port: number | null, timeoutMs?: number) => {
  const c = createFilmCraftClient(() => (port === null ? null : { port, token: TOKEN }), {
    timeoutMs,
  });
  clients.push(c);
  return c;
};

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const s of servers.splice(0)) {
    await new Promise((ok) => s.close(ok));
  }
});

describe("filmcraft client", () => {
  it("sends an engine command as one line with the token and returns its result", async () => {
    const fc = await serve((req, socket) =>
      reply(socket, { id: req.id, ok: true, result: { id: 7 } }),
    );
    await expect(client(fc.port).exec("sequence.inspect", { item: 3 })).resolves.toEqual({ id: 7 });
    expect(fc.requests).toEqual([
      {
        id: expect.any(Number),
        token: TOKEN,
        method: "engine.execute",
        params: { command: "sequence.inspect", params: { item: 3 } },
      },
    ]);
  });

  it("rejects with FilmCraft's error when ok is false, without trying again", async () => {
    const fc = await serve((req, socket) =>
      reply(socket, { id: req.id, ok: false, error: "track is locked" }),
    );
    const err = await client(fc.port)
      .exec("timeline.place", {})
      .catch((e: Error) => e);
    expect((err as Error).message).toBe("track is locked");
    expect((err as Error).message).not.toContain(TOKEN);
    expect(fc.requests).toHaveLength(1);
  });

  it("takes an error reply without an id, which FilmCraft sends before closing the connection", async () => {
    const fc = await serve((_req, socket) => {
      reply(socket, { ok: false, error: "bad token, closing the connection" });
      socket.end();
    });
    await expect(client(fc.port).exec("sequence.inspect")).rejects.toThrow("bad token");
    expect(fc.requests).toHaveLength(1);
  });

  it("connects again when FilmCraft closed the connection while it was idle", async () => {
    const fc = await serve((req, socket) =>
      reply(socket, { id: req.id, ok: true, result: req.id }),
    );
    const c = client(fc.port);
    await expect(c.exec("sequence.inspect")).resolves.toEqual(expect.any(Number));
    // FilmCraft drops connections idle for two minutes
    const closed = fc.nextClose();
    fc.endAll();
    await closed;
    await expect(c.exec("sequence.inspect")).resolves.toEqual(expect.any(Number));
    expect(fc.connections()).toBe(2);
    expect(fc.requests).toHaveLength(2);
  });

  it("never sends a request again once it went out, and says the connection was lost", async () => {
    const fc = await serve((req, socket, n) => {
      if (n === 1) socket.destroy();
      else reply(socket, { id: req.id, ok: true, result: n });
    });
    const c = client(fc.port);
    await expect(c.exec("timeline.place")).rejects.toThrow(CONNECTION_LOST);
    expect(fc.requests).toHaveLength(1);
    // the next request goes on a new connection
    await expect(c.exec("sequence.inspect")).resolves.toBe(2);
  });

  it("says NOT_RUNNING when FilmCraft quit with a request out", async () => {
    const fc = await serve((_req, socket) => {
      fc.server.close();
      socket.destroy();
    });
    await expect(client(fc.port).exec("timeline.place")).rejects.toThrow(NOT_RUNNING);
    expect(fc.requests).toHaveLength(1);
  });

  it("gives up on a reply that does not come, and the requests after it still go", async () => {
    const fc = await serve((req, socket, n) => {
      if (n > 1) reply(socket, { id: req.id, ok: true, result: n });
    });
    const c = client(fc.port, 50);
    const hung = c.exec("sequence.inspect");
    const next = c.exec("project.inspect");
    await expect(hung).rejects.toThrow(TIMED_OUT);
    await expect(next).resolves.toBe(2);
    expect(fc.connections()).toBe(2);
  });

  it("waits as long as a call allows", async () => {
    const fc = await serve((req, socket) =>
      setTimeout(() => reply(socket, { id: req.id, ok: true, result: "done" }), 80),
    );
    await expect(
      client(fc.port, 20).exec("file.exportMedia", {}, { timeoutMs: null }),
    ).resolves.toBe("done");
  });

  it("sends a call of its own past a request that holds the shared connection", async () => {
    let release: () => void = () => undefined;
    const fc = await serve((req, socket) => {
      const answer = () => reply(socket, { id: req.id, ok: true, result: req.params.command });
      if (req.params.command === "file.exportMedia") release = answer;
      else answer();
    });
    const c = client(fc.port);
    const exporting = c.exec("file.exportMedia", {}, { timeoutMs: null });
    await expect.poll(() => fc.requests.length).toBe(1);
    await expect(c.exec("export.queue.cancel", {}, { alone: true })).resolves.toBe(
      "export.queue.cancel",
    );
    release();
    await expect(exporting).resolves.toBe("file.exportMedia");
    expect(fc.connections()).toBe(2);
  });

  it("says NOT_RUNNING when there is no endpoint or nothing listens on the port", async () => {
    await expect(client(null).exec("sequence.inspect")).rejects.toThrow(NOT_RUNNING);
    const probe = createServer();
    await new Promise<void>((ok) => probe.listen(0, "127.0.0.1", ok));
    const port = (probe.address() as { port: number }).port;
    await new Promise((ok) => probe.close(ok));
    const err = await client(port)
      .exec("sequence.inspect")
      .catch((e: Error) => e);
    expect((err as Error).message).toBe(NOT_RUNNING);
  });

  it("passes over a line for another request and waits for its own", async () => {
    const fc = await serve((req, socket) => {
      reply(socket, { id: req.id + 100, ok: true, result: "not this" });
      setTimeout(() => reply(socket, { id: req.id, ok: true, result: "this" }), 10);
    });
    await expect(client(fc.port).exec("project.inspect")).resolves.toBe("this");
  });

  it("sends one request at a time", async () => {
    const fc = await serve((req, socket) =>
      setTimeout(() => reply(socket, { id: req.id, ok: true, result: req.params.command }), 5),
    );
    const c = client(fc.port);
    const all = await Promise.all([c.exec("a"), c.exec("b"), c.exec("c")]);
    expect(all).toEqual(["a", "b", "c"]);
    expect(fc.connections()).toBe(1);
  });
});
