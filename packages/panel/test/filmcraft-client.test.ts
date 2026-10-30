import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createFilmCraftClient, NOT_RUNNING, type FilmCraftClient } from "../src/filmcraft/client";

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
  const server: Server = createServer((socket) => {
    connections++;
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
  return { port, requests, connections: () => connections };
}

const reply = (socket: Socket, body: object) => socket.write(JSON.stringify(body) + "\n");

const servers: Server[] = [];
const clients: FilmCraftClient[] = [];
const client = (port: number | null) => {
  const c = createFilmCraftClient(() => (port === null ? null : { port, token: TOKEN }));
  clients.push(c);
  return c;
};

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const s of servers.splice(0)) {
    s.closeAllConnections?.();
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

  it("connects again once when FilmCraft dropped the connection", async () => {
    const fc = await serve((req, socket, n) => {
      // the first request finds the connection gone (FilmCraft closes idle ones)
      if (n === 1) return socket.destroy();
      reply(socket, { id: req.id, ok: true, result: n });
      if (n === 2) socket.end();
    });
    const c = client(fc.port);
    await expect(c.exec("sequence.inspect")).resolves.toBe(2);
    expect(fc.connections()).toBe(2);
    // and a connection FilmCraft ended between requests is made again for the next one
    await new Promise((ok) => setTimeout(ok, 20));
    await expect(c.exec("sequence.inspect")).resolves.toBe(3);
    expect(fc.connections()).toBe(3);
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
