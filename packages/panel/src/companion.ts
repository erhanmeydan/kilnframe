// Client side of docs/companion-protocol.md. UXP can only be a WebSocket client; the companion is the server.
import { homeDir } from "./home";
import { host } from "./host";
import { t } from "./i18n";

export interface ConnectionInfo {
  port: number;
  token: string;
  version: string;
}

export async function connectionFilePath(): Promise<string> {
  return `${await homeDir()}/.kilnframe/companion.json`;
}

export async function readConnection(): Promise<ConnectionInfo> {
  const text = await host().readTextFile(await connectionFilePath());
  return JSON.parse(text) as ConnectionInfo;
}

/**
 * The protocol this panel speaks (packages/companion/src/protocol.ts PROTOCOL_VERSION). The companion says
 * its own in "ready"; when they differ the panel tells which side to update instead of failing oddly.
 */
export const PROTOCOL_VERSION = 2;

/** Which side is out of date, from the protocol the companion reported: an older companion means the app, a newer one the panel. */
export function protocolMismatch(theirs: number): "app" | "panel" | null {
  return theirs < PROTOCOL_VERSION ? "app" : theirs > PROTOCOL_VERSION ? "panel" : null;
}

/** The largest message the companion takes (packages/companion/src/protocol.ts MAX_MESSAGE_BYTES). */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export interface CompanionClient {
  socket: WebSocket;
  /** The companion's protocol and version, from its "ready". */
  ready: { protocol: number; version: string };
  send(message: unknown): void;
  close(): void;
}

/** Opens the socket, authenticates with the token and resolves on "ready". */
export function connect(
  host: string,
  info: ConnectionInfo,
  onMessage: (message: { type: string } & Record<string, unknown>) => void,
): Promise<CompanionClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://${host}:${info.port}`);
    const client: CompanionClient = {
      socket,
      ready: { protocol: 0, version: "" },
      send: (m) => socket.send(JSON.stringify(m)),
      close: () => socket.close(),
    };
    let ready = false;
    socket.onopen = () =>
      client.send({
        type: "hello",
        token: info.token,
        client: "premiere-panel",
        protocol: PROTOCOL_VERSION,
      });
    socket.onmessage = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as { type: string } & Record<string, unknown>;
      if (!ready && message.type === "ready") {
        ready = true;
        client.ready = {
          protocol: Number(message.protocol) || 0,
          version: String(message.version ?? ""),
        };
        resolve(client);
      }
      onMessage(message);
    };
    socket.onerror = () => {
      if (!ready) reject(new Error(t("conn.failed", { host, port: info.port })));
    };
    socket.onclose = (event: CloseEvent) => {
      if (!ready)
        reject(new Error(t("conn.closedCode", { code: event.code, reason: event.reason })));
    };
  });
}
