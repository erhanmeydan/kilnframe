import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { LISTEN_HOST, LISTEN_HOST_V6, isLoopbackAddress } from "./loopback.js";
import type { KeyStore } from "./keys.js";
import {
  ClientMessageSchema,
  PROTOCOL_VERSION,
  type AppUpdateState,
  type ServerMessage,
} from "./protocol.js";
import { JobQueue, type JobRunner } from "./queue.js";

export interface CompanionOptions {
  token: string;
  keys: KeyStore;
  runner: JobRunner;
  version: string;
  /** 0 picks a free port (tests). */
  port: number;
  /** A client must say hello with the token within this time. */
  helloTimeoutMs?: number;
  /** GPU, FFmpeg and model checks for the panel's onboarding screen. */
  systemCheck?: () => Promise<unknown>;
  /** Downloads and loads the speech model ahead of the first job (onboarding). */
  prepareModels?: (onProgress: (message: string) => void) => Promise<void>;
  /** Models the stored key or account can use, with known prices, for the panel's model picker. */
  listModels?: (provider: string, baseURL?: string) => Promise<unknown[]>;
  /** A job folder's stills and frame size from disk, or null when it has none yet. */
  loadReview?: (outDir: string) => Promise<unknown>;
  /** The provider presets with whether a key is stored, and the Claude Code sign-in, for the settings. */
  listProviders?: () => Promise<{
    providers: unknown[];
    claudeCode: unknown;
    codex: unknown;
    grok: unknown;
    updates: unknown;
  }>;
  /** Opens an agent CLI's own sign-in (claude auth login, codex login) in a terminal window. */
  loginAgent?: (agent: "claude-code" | "codex" | "grok") => Promise<void>;
  /** Runs an agent CLI's own sign-out (claude auth logout, codex logout, grok logout). */
  logoutAgent?: (
    agent: "claude-code" | "codex" | "grok",
  ) => Promise<{ ok: boolean; error?: string }>;
  /** Opens an agent CLI's own update (claude update, codex update, grok update) in a terminal window. */
  updateAgent?: (agent: "claude-code" | "codex" | "grok") => Promise<void>;
  /** One short request with a picture through a provider (the settings' connection test). */
  testProvider?: (provider: string, model?: string, baseURL?: string) => Promise<unknown>;
  /** Style cards (name, display name, summary, thumbnail) for the panel's style picker. */
  listStyles?: () => Promise<unknown[]>;
  /** The speech provider's voices and whether its key is set, for story mode. */
  listVoices?: () => Promise<{
    provider: string;
    model: string;
    voices: unknown[];
    keySet: boolean;
  }>;
  /** Says a short sample with a voice through the system's speakers; `onEnd` when it stops playing. */
  previewVoice?: (voice: string, language: string, onEnd: () => void) => Promise<void>;
  /** Stops the sample that is playing. */
  stopVoice?: () => void;
  /** Plays a sound file (a music clip or preview); the server checks the file is one. */
  playAudio?: (file: string, onEnd: () => void) => void;
  /** Deletes one of the editor's own styles. */
  deleteStyle?: (name: string) => Promise<void>;
  /** Thumbnails and sizes of the editor's images for the panel, or why one cannot be used. */
  inspectImages?: (paths: string[]) => Promise<unknown[]>;
  /** The app's update channel; absent when the companion runs on its own (development, CLI). */
  appUpdates?: AppUpdates | undefined;
  /** Whether a job is running or waiting, for the app: it holds off quitting while the companion is busy. */
  onBusy?: (busy: boolean) => void;
  /** The folder for the Captions tab's preview frames (under the app's own folder). */
  captionPreviews?: () => Promise<string>;
  /** Keeps the Captions tab's state in a caption job folder. */
  saveCaptions?: (jobDir: string, state: Record<string, unknown>) => Promise<void>;
  /** What a caption job folder keeps, or null. */
  loadCaptions?: (jobDir: string) => Promise<unknown>;
  /** Creates a job folder next to the Premiere project and returns its path. */
  prepareJob?: (
    projectPath: string | undefined,
    sequenceName: string,
    jobRoot?: string,
  ) => Promise<string>;
}

export interface AppUpdates {
  /** The last state the app reported, or null before its first check. */
  state(): AppUpdateState | null;
  /** Called with every new state. */
  onState(listener: (state: AppUpdateState) => void): void;
  /** Downloads (if needed) and installs; the app quits and reopens. */
  install(): void;
}

export interface Companion {
  port: number;
  close(): Promise<void>;
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Local WebSocket API for the Premiere panel: loopback only, token authenticated. */
export function startCompanion(o: CompanionOptions): Promise<Companion> {
  const clients = new Set<WebSocket>();
  const broadcast = (msg: ServerMessage) => {
    const data = JSON.stringify(msg);
    for (const c of clients) if (c.readyState === c.OPEN) c.send(data);
  };
  /**
   * Job folders whose stills wait for the editor's approval: the animation is not done until its render is,
   * so the app keeps asking before it quits. Cleared by the render, by leaving the review, or when no panel
   * is connected any more (Premiere quit with the review open).
   */
  const pendingReviews = new Set<string>();
  let saidBusy = false;
  const tellBusy = () => {
    const busy = queue.busy() || (pendingReviews.size > 0 && clients.size > 0);
    if (busy === saidBusy) return;
    saidBusy = busy;
    o.onBusy?.(busy);
  };
  /** A finished job: stills open a review, its render (done, failed or stopped) closes it. */
  const reviewAfter = (jobId: string, done: boolean) => {
    const p = queue.paramsOf(jobId) as { outDir?: string; stillsOnly?: boolean; action?: string };
    if (!p?.outDir) return;
    if (p.action === "render") pendingReviews.delete(p.outDir);
    else if (done && (p.stillsOnly || p.action === "recompose")) pendingReviews.add(p.outDir);
  };
  const queue = new JobQueue(
    o.runner,
    {
      queued: (jobId, position) => broadcast({ type: "job.queued", jobId, position }),
      progress: (jobId, message) => broadcast({ type: "job.progress", jobId, message }),
      done: (jobId, result) => {
        reviewAfter(jobId, true);
        broadcast({ type: "job.done", jobId, result });
      },
      failed: (jobId, message, kind) => {
        reviewAfter(jobId, false);
        broadcast({ type: "job.error", jobId, message, kind });
      },
      cancelled: (jobId) => {
        reviewAfter(jobId, false);
        broadcast({ type: "job.cancelled", jobId });
      },
    },
    () => tellBusy(),
  );

  o.appUpdates?.onState((update) => broadcast({ type: "app.update", update }));

  const wss = new WebSocketServer({ host: LISTEN_HOST, port: o.port, maxPayload: 1 << 20 });

  const onConnection = (ws: WebSocket, req: IncomingMessage) => {
    if (!isLoopbackAddress(req.socket.remoteAddress ?? "")) {
      ws.close(1008, "loopback only");
      return;
    }
    let authed = false;
    const send = (msg: ServerMessage) => ws.send(JSON.stringify(msg));
    const timer = setTimeout(() => {
      if (!authed) ws.close(1008, "hello timeout");
    }, o.helloTimeoutMs ?? 5000);

    ws.on("close", () => {
      clearTimeout(timer);
      clients.delete(ws);
      // the last panel gone: a review left open no longer holds the app
      tellBusy();
    });

    ws.on("message", async (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        send({ type: "error", message: "Messages must be JSON." });
        return;
      }
      const result = ClientMessageSchema.safeParse(parsed);
      if (!result.success) {
        const ref = (parsed as { ref?: unknown } | null)?.ref;
        send({
          type: "error",
          message: `Invalid message: ${result.error.issues.map((i) => i.message).join("; ")}`,
          ...(typeof ref === "string" ? { ref } : {}),
        });
        return;
      }
      const msg = result.data;
      if (!authed) {
        if (msg.type !== "hello" || !sameToken(msg.token, o.token)) {
          ws.close(1008, "unauthorized");
          return;
        }
        authed = true;
        clearTimeout(timer);
        clients.add(ws);
        send({ type: "ready", protocol: PROTOCOL_VERSION, version: o.version });
        const update = o.appUpdates?.state();
        if (update) send({ type: "app.update", update });
        return;
      }
      try {
        switch (msg.type) {
          case "hello":
            send({ type: "ready", protocol: PROTOCOL_VERSION, version: o.version });
            break;
          case "app.update.install":
            if (!o.appUpdates)
              send({ type: "error", message: "This companion cannot update itself." });
            else if (queue.busy()) send({ type: "app.update.busy" });
            else o.appUpdates.install();
            break;
          case "status":
            send({ type: "status", jobs: queue.summaries() });
            break;
          case "models.list":
            send({
              type: "models",
              provider: msg.provider,
              models: o.listModels ? await o.listModels(msg.provider, msg.baseURL) : [],
            });
            break;
          case "models.prepare":
            try {
              if (o.prepareModels)
                await o.prepareModels((message) => broadcast({ type: "models.progress", message }));
              broadcast({ type: "models.ready" });
            } catch (err) {
              // a download that stops (no network, no space) must end the panel's wait with a reason
              broadcast({
                type: "models.failed",
                message: err instanceof Error ? err.message : String(err),
              });
            }
            break;
          case "system.check":
            send({ type: "system", report: o.systemCheck ? await o.systemCheck() : null });
            break;
          case "job.start": {
            const jobId = queue.enqueue(msg.params);
            send({ type: "job.accepted", jobId, ...(msg.ref ? { ref: msg.ref } : {}) });
            break;
          }
          case "styles.list":
            send({ type: "styles", styles: o.listStyles ? await o.listStyles() : [] });
            break;
          case "job.prepare":
            if (!o.prepareJob) throw new Error("job folders are not supported");
            send({
              type: "job.prepared",
              jobDir: await o.prepareJob(msg.projectPath, msg.sequenceName, msg.jobRoot),
              ...(msg.ref ? { ref: msg.ref } : {}),
            });
            break;
          case "captions.previews":
            if (!o.captionPreviews) throw new Error("captions are not supported");
            send({
              type: "captions.previews",
              dir: await o.captionPreviews(),
              ...(msg.ref ? { ref: msg.ref } : {}),
            });
            break;
          case "captions.save":
            if (!o.saveCaptions) throw new Error("captions are not supported");
            await o.saveCaptions(msg.jobDir, msg.state);
            send({
              type: "captions.saved",
              jobDir: msg.jobDir,
              ...(msg.ref ? { ref: msg.ref } : {}),
            });
            break;
          case "captions.load":
            send({
              type: "captions.loaded",
              jobDir: msg.jobDir,
              state: o.loadCaptions ? await o.loadCaptions(msg.jobDir) : null,
              ...(msg.ref ? { ref: msg.ref } : {}),
            });
            break;
          case "speech.voices": {
            if (!o.listVoices) throw new Error("story mode is not supported");
            send({ type: "voices", ...(await o.listVoices()) });
            break;
          }
          case "speech.preview":
            if (!o.previewVoice) throw new Error("story mode is not supported");
            await o.previewVoice(msg.voice, msg.language, () =>
              broadcast({ type: "speech.ended", voice: msg.voice }),
            );
            send({ type: "speech.played", voice: msg.voice });
            break;
          case "audio.play":
            // only the Music tab's own clips: never any file a page names
            if (!/[\\/]music[\\/](preview[\\/])?s\d+(-\d+)?\.wav$/.test(msg.file))
              throw new Error("Only music clips can be played.");
            if (!o.playAudio) throw new Error("playing music is not supported");
            o.playAudio(msg.file, () => broadcast({ type: "audio.ended" }));
            send({ type: "audio.played" });
            break;
          case "speech.stop":
            o.stopVoice?.();
            broadcast({ type: "speech.ended", voice: "" });
            break;
          case "styles.delete":
            if (!o.deleteStyle) throw new Error("deleting styles is not supported");
            await o.deleteStyle(msg.name);
            send({ type: "styles.deleted", name: msg.name });
            break;
          case "assets.inspect":
            send({
              type: "assets",
              assets: o.inspectImages ? await o.inspectImages(msg.paths) : [],
            });
            break;
          case "job.get": {
            // the same message the broadcast sent, for a panel that missed it
            const job = queue.get(msg.jobId);
            if (job?.state === "done")
              send({ type: "job.done", jobId: msg.jobId, result: job.result });
            else if (job?.state === "failed")
              send({
                type: "job.error",
                jobId: msg.jobId,
                message: job.error ?? "",
                kind: job.errorKind,
              });
            else if (job?.state === "cancelled") send({ type: "job.cancelled", jobId: msg.jobId });
            else send({ type: "job.state", jobId: msg.jobId, state: job?.state ?? "unknown" });
            break;
          }
          case "job.cancel":
            if (!queue.cancel(msg.jobId))
              send({ type: "error", message: "This job has already finished." });
            break;
          case "review.closed":
            if (msg.outDir) pendingReviews.delete(msg.outDir);
            else pendingReviews.clear();
            tellBusy();
            break;
          case "review.load":
            send({
              type: "review",
              outDir: msg.outDir,
              review: o.loadReview ? await o.loadReview(msg.outDir) : null,
            });
            break;
          case "agent.update":
            if (o.updateAgent) await o.updateAgent(msg.agent);
            send({ type: "agent.update.opened", agent: msg.agent });
            break;
          case "agent.login":
            if (o.loginAgent) await o.loginAgent(msg.agent);
            send({ type: "agent.login.opened", agent: msg.agent });
            break;
          case "agent.logout": {
            // a running job may be using that agent, and the sign-out holds the companion for seconds
            const r = queue.busy()
              ? { ok: false, error: "busy" }
              : o.logoutAgent
                ? await o.logoutAgent(msg.agent)
                : { ok: false };
            send({ type: "agent.logout.done", agent: msg.agent, ...r });
            break;
          }
          case "providers.list": {
            const r = o.listProviders
              ? await o.listProviders()
              : { providers: [], claudeCode: null, codex: null, grok: null, updates: null };
            send({ type: "providers", ...r });
            break;
          }
          case "providers.test":
            send({
              type: "providers.tested",
              provider: msg.provider,
              result: o.testProvider
                ? await o.testProvider(msg.provider, msg.model, msg.baseURL)
                : null,
            });
            break;
          case "keys.set":
            await o.keys.set(msg.provider, msg.key);
            send({ type: "keys.saved", provider: msg.provider });
            break;
          case "keys.has":
            send({
              type: "keys.has",
              provider: msg.provider,
              present: (await o.keys.get(msg.provider)) !== undefined,
            });
            break;
          case "keys.delete":
            await o.keys.delete(msg.provider);
            send({ type: "keys.deleted", provider: msg.provider });
            break;
        }
      } catch (err) {
        // never echo request contents back: a keys.set failure must not leak the key
        send({
          type: "error",
          message: `Could not complete ${msg.type}: ${err instanceof Error ? err.name : "error"}`,
          // the request's own ref, so the panel fails that request and no other
          ...("ref" in msg && msg.ref ? { ref: msg.ref } : {}),
        });
      }
    });
  };
  wss.on("connection", onConnection);

  return new Promise((resolve, reject) => {
    wss.once("error", reject);
    wss.once("listening", () => {
      const port = (wss.address() as AddressInfo).port;
      // the panel may only connect to ws://localhost, which Windows resolves to ::1 first and does not retry on
      // 127.0.0.1 (11 Oct 2026); so the IPv6 loopback answers on the same port too, where the computer has one
      const wss6 = new WebSocketServer({ host: LISTEN_HOST_V6, port, maxPayload: 1 << 20 });
      wss6.on("connection", onConnection);
      const v6Ready = new Promise<void>((ready) => {
        wss6.once("listening", () => ready());
        wss6.once("error", () => {
          wss6.close();
          ready();
        });
      });
      const closeServer = (server: WebSocketServer) =>
        new Promise<void>((done) => {
          for (const c of server.clients) c.terminate();
          server.close(() => done());
        });
      void v6Ready.then(() =>
        resolve({
          port,
          close: async () => {
            await Promise.all([closeServer(wss), closeServer(wss6)]);
          },
        }),
      );
    });
  });
}
