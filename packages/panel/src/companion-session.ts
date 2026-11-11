// One long-lived connection to the companion with typed requests (docs/companion-protocol.md).
import { t } from "./i18n";
import { connect, readConnection, type CompanionClient } from "./companion";

export type ServerMessage = { type: string } & Record<string, unknown>;
type Listener = (message: ServerMessage) => void;

/** Messages after which a job sends nothing more. */
const JOB_ENDS = new Set(["job.done", "job.error", "job.cancelled"]);

export class CompanionSession {
  private client: CompanionClient | null = null;
  private listeners = new Set<Listener>();
  /** Requests waiting for their reply, by ref. */
  private waiting = new Set<string>();
  /** Jobs this session saw start or move and not end yet. */
  private running = new Set<string>();

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
    this.client = await connect("localhost", info, (m) => this.dispatch(m));
    this.client.socket.addEventListener("close", () => this.closed(onClose));
  }

  private dispatch(m: ServerMessage) {
    const jobId = typeof m.jobId === "string" ? m.jobId : null;
    if (jobId) {
      if (JOB_ENDS.has(m.type) || (m.type === "job.state" && m.state === "unknown"))
        this.running.delete(jobId);
      else if (m.type === "job.accepted" || m.type === "job.progress") this.running.add(jobId);
    }
    for (const l of [...this.listeners]) l(m);
  }

  /**
   * The connection closed: nothing more will come for the requests and jobs in flight, so every follower
   * hears it now (a job as an error marked connectionLost) instead of waiting forever with its screen locked.
   */
  private closed(onClose: () => void) {
    this.client = null;
    for (const ref of [...this.waiting])
      this.dispatch({ type: "error", message: t("conn.closed"), ref });
    for (const jobId of [...this.running])
      this.dispatch({
        type: "job.error",
        jobId,
        message: t("job.connectionLost"),
        connectionLost: true,
      });
    this.running.clear();
    onClose();
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(message: unknown): void {
    if (!this.client) throw new Error(t("conn.notConnected"));
    this.client.send(message);
  }

  /**
   * Sends a message and resolves with its reply of the given type (or rejects on "error"). Every request
   * carries its own `ref`; a reply that echoes another request's ref is not this one's, so two job.start or
   * job.prepare requests in flight never swap their job ids or folders. A reply without a ref (messages the
   * companion does not echo it for) is taken as before; an error without one is not.
   */
  request<T extends ServerMessage>(
    message: unknown,
    replyType: string,
    timeoutMs = 60_000,
  ): Promise<T> {
    const ref = `r${++requests}-${Date.now()}`;
    const sent = message && typeof message === "object" ? { ...(message as object), ref } : message;
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        off();
        this.waiting.delete(ref);
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error(t("conn.noReply")));
      }, timeoutMs);
      const off = this.on((m) => {
        if (m.type !== replyType && m.type !== "error") return;
        if (m.ref !== undefined && m.ref !== ref) return;
        // an error that names no request answers a plain send (job.cancel on a finished job), not this one
        if (m.type === "error" && m.ref === undefined) return;
        done();
        if (m.type === "error") reject(new Error(String(m.message)));
        else resolve(m as T);
      });
      this.waiting.add(ref);
      try {
        this.send(sent);
      } catch (err) {
        done();
        reject(err);
      }
    });
  }
}

let requests = 0;
