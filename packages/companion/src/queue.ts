import { randomUUID } from "node:crypto";
import type { JobParams, JobState, JobSummary } from "./protocol.js";

export interface JobEvents {
  progress(message: string): void;
  /** Aborted when the editor stops the job; the runner ends its work (and every program it started). */
  signal: AbortSignal;
}

export type JobRunner = (params: JobParams, events: JobEvents) => Promise<unknown>;

interface Job {
  id: string;
  params: JobParams;
  state: JobState;
  createdAt: Date;
  /** Kept so a client that missed the broadcast (panel reload, sleep) can ask again. */
  result?: unknown;
  error?: string;
  /** What kind of failure, when the error says (ProviderError's kind, such as "cut-off"). */
  errorKind?: string;
}

/** The kind a failed job's error carries, so the panel can explain it in the user's language. */
export function errorKind(err: unknown): string | undefined {
  const kind = (err as { kind?: unknown } | null)?.kind;
  return typeof kind === "string" ? kind : undefined;
}

export interface QueueListener {
  queued(jobId: string, position: number): void;
  progress(jobId: string, message: string): void;
  done(jobId: string, result: unknown): void;
  failed(jobId: string, message: string, kind?: string): void;
  cancelled(jobId: string): void;
}

/** One render at a time; later jobs wait in order. */
export class JobQueue {
  private readonly jobs: Job[] = [];
  private running = false;
  /** What onBusy last said. */
  private saidBusy = false;
  /** Stops the running job. */
  private stopRunning: { jobId: string; controller: AbortController } | null = null;

  constructor(
    private readonly runner: JobRunner,
    private readonly listener: QueueListener,
    /** True when a job starts with nothing running, false when the last queued job has finished. */
    private readonly onBusy?: (busy: boolean) => void,
  ) {}

  enqueue(params: JobParams): string {
    const job: Job = { id: randomUUID(), params, state: "queued", createdAt: new Date() };
    this.jobs.push(job);
    this.listener.queued(job.id, this.position(job.id) ?? 0);
    void this.pump();
    return job.id;
  }

  /**
   * Stops a job: a queued one never starts, a running one is aborted (the runner stops the model call,
   * the render and every program it started). Finished jobs cannot be cancelled.
   */
  cancel(jobId: string): boolean {
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job || (job.state !== "queued" && job.state !== "running")) return false;
    const wasRunning = job.state === "running";
    job.state = "cancelled";
    this.listener.cancelled(jobId);
    if (wasRunning && this.stopRunning?.jobId === jobId) this.stopRunning.controller.abort();
    return true;
  }

  /** A job is running or waiting: no update is installed now. */
  /** A job's parameters, while the queue keeps it. */
  paramsOf(jobId: string): JobParams | undefined {
    return this.jobs.find((j) => j.id === jobId)?.params;
  }

  busy(): boolean {
    return this.running || this.jobs.some((j) => j.state === "queued");
  }

  /** Aborts the running job, if any (the companion is quitting). */
  stopAll(): void {
    this.stopRunning?.controller.abort();
  }

  position(jobId: string): number | null {
    const waiting = this.jobs.filter((j) => j.state === "queued");
    const i = waiting.findIndex((j) => j.id === jobId);
    return i < 0 ? null : i + 1;
  }

  /** A job's state with its result or error once finished; null for unknown ids. */
  get(
    jobId: string,
  ): { state: JobState; result?: unknown; error?: string; errorKind?: string } | null {
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job) return null;
    return {
      state: job.state,
      ...(job.state === "done" ? { result: job.result } : {}),
      ...(job.error !== undefined ? { error: job.error } : {}),
      ...(job.errorKind !== undefined ? { errorKind: job.errorKind } : {}),
    };
  }

  summaries(): JobSummary[] {
    return this.jobs.map((j) => ({
      id: j.id,
      state: j.state,
      position: this.position(j.id),
      style:
        j.params.kind === "style"
          ? "style-create"
          : j.params.kind === "story-write" ||
              j.params.kind === "story-voice" ||
              j.params.kind === "parts" ||
              j.params.kind === "music-plan" ||
              j.params.kind === "music-make"
            ? j.params.kind
            : j.params.style,
      createdAt: j.createdAt.toISOString(),
    }));
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const job = this.jobs.find((j) => j.state === "queued");
    if (!job) return;
    this.running = true;
    if (!this.saidBusy) {
      this.saidBusy = true;
      this.onBusy?.(true);
    }
    job.state = "running";
    const controller = new AbortController();
    this.stopRunning = { jobId: job.id, controller };
    // cancel() may change the state while the runner is awaited
    const cancelled = () => (job.state as JobState) === "cancelled";
    try {
      const result = await this.runner(job.params, {
        progress: (m) => {
          if (!cancelled()) this.listener.progress(job.id, m);
        },
        signal: controller.signal,
      });
      if (!cancelled()) {
        job.state = "done";
        job.result = result;
        this.listener.done(job.id, result);
      }
    } catch (err) {
      if (!cancelled()) {
        job.state = "failed";
        job.error = err instanceof Error ? err.message : String(err);
        const kind = errorKind(err);
        if (kind) job.errorKind = kind;
        this.listener.failed(job.id, job.error, kind);
      }
    } finally {
      this.stopRunning = null;
      this.running = false;
      if (!this.jobs.some((j) => j.state === "queued")) {
        this.saidBusy = false;
        this.onBusy?.(false);
      }
      void this.pump();
    }
  }
}
