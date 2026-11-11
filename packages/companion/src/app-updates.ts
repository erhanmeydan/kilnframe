import type { AppUpdateState } from "./protocol.js";
import type { AppUpdates } from "./server.js";

/** What the app (packages/app) and the companion say to each other over Node's IPC channel. */
export type ParentMessage =
  | { type: "update.state"; state: AppUpdateState }
  /** The app quits: the companion stops its job and everything that job started, then exits. */
  | { type: "quit" };
export type ChildMessage = { type: "update.install" } | { type: "job.busy"; busy: boolean };

interface Channel {
  send?: (message: ChildMessage) => unknown;
  /** False once the app is gone: a send then would throw. */
  connected?: boolean;
  on(event: "message", listener: (message: unknown) => void): unknown;
}

/**
 * The update channel when the companion runs inside Kilnframe Helper, which starts it with an IPC channel;
 * undefined when it runs on its own (development, tests), so the panel shows no update.
 */
export function appUpdatesFromParent(
  channel: Channel = process as unknown as Channel,
): AppUpdates | undefined {
  if (typeof channel.send !== "function") return undefined;
  let last: AppUpdateState | null = null;
  const listeners: ((state: AppUpdateState) => void)[] = [];
  channel.on("message", (message) => {
    const m = message as Partial<ParentMessage>;
    if (m?.type !== "update.state" || !m.state) return;
    last = m.state;
    for (const l of listeners) l(m.state);
  });
  return {
    state: () => last,
    onState: (listener) => listeners.push(listener),
    install: () => {
      if (channel.connected !== false) channel.send?.({ type: "update.install" });
    },
  };
}
