// One long-lived connection to the companion with typed requests (docs/companion-protocol.md).
import { t } from "./i18n";
import { connect, readConnection, type CompanionClient } from "./companion";

export type ServerMessage = { type: string } & Record<string, unknown>;
type Listener = (message: ServerMessage) => void;

export class CompanionSession {
  private client: CompanionClient | null = null;
  private listeners = new Set<Listener>();

  /** The companion's protocol and version, once connected. */
  get ready(): { protocol: number; version: string } | null {
    return this.client?.ready ?? null;
  }

  get connected(): boolean {
    return this.client !== null;
  }

  /** Reads ~/.kilnframe/companion.json and authenticates. UXP only allows ws://localhost. */
  async open(onClose: () => void): Promise<void> {
    const info = await readConnection();
    this.client = await connect("localhost", info, (m) => {
      for (const l of [...this.listeners]) l(m);
    });
    this.client.socket.addEventListener("close", () => {
      this.client = null;
      onClose();
    });
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(message: unknown): void {
    if (!this.client) throw new Error(t("conn.notConnected"));
    this.client.send(message);
  }

  /** Sends a message and resolves with the first reply of the given type (or rejects on "error"). */
  request<T extends ServerMessage>(
    message: unknown,
    replyType: string,
    timeoutMs = 60_000,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(t("conn.noReply")));
      }, timeoutMs);
      const off = this.on((m) => {
        if (m.type === replyType || m.type === "error") {
          clearTimeout(timer);
          off();
          if (m.type === "error") reject(new Error(String(m.message)));
          else resolve(m as T);
        }
      });
      try {
        this.send(message);
      } catch (err) {
        clearTimeout(timer);
        off();
        reject(err);
      }
    });
  }
}
