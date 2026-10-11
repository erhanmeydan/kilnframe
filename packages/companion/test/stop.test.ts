import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedRunner } from "../src/isolated.js";
import { JobQueue } from "../src/queue.js";
import type { JobParams } from "../src/protocol.js";

const slowWorker = fileURLToPath(new URL("./fixtures/slow-worker.mjs", import.meta.url));
const params = (extra: Record<string, unknown>) => extra as unknown as JobParams;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const waitFor = async (check: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe("isolated jobs", () => {
  it("passes progress and the result through", async () => {
    const seen: string[] = [];
    const run = isolatedRunner(slowWorker);
    const result = await run(params({ quick: true }), {
      progress: (m) => seen.push(m),
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ ok: true });
    expect(seen).toEqual(["Planning scenes"]);
  });

  it("reports a failed job", async () => {
    const run = isolatedRunner(slowWorker);
    await expect(
      run(params({ fail: true }), { progress: () => {}, signal: new AbortController().signal }),
    ).rejects.toThrow("model refused");
  });

  it.skipIf(process.platform === "win32")(
    "stops the job and every program it started",
    { timeout: 15_000 },
    async () => {
      const controller = new AbortController();
      let childPid = 0;
      const run = isolatedRunner(slowWorker);
      const done = run(params({}), {
        progress: (m) => (childPid = Number(m.replace("child ", ""))),
        signal: controller.signal,
      });
      await waitFor(() => childPid > 0);
      expect(alive(childPid)).toBe(true);
      controller.abort();
      await expect(done).rejects.toThrow("stopped");
      await waitFor(() => !alive(childPid));
    },
  );
});

describe("stopping a running job in the queue", () => {
  it("aborts the runner, reports cancelled once and starts the next job", async () => {
    const events: string[] = [];
    const queue = new JobQueue(
      (p, ev) =>
        new Promise((resolve, reject) => {
          if ((p as unknown as { quick?: boolean }).quick) return resolve("second done");
          ev.signal.addEventListener("abort", () => reject(new Error("The job was stopped.")));
        }),
      {
        queued: () => {},
        progress: () => {},
        done: (id, r) => events.push(`done ${String(r)}`),
        failed: (id, m) => events.push(`failed ${m}`),
        cancelled: () => events.push("cancelled"),
      },
    );
    const first = queue.enqueue(params({}));
    queue.enqueue(params({ quick: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(queue.get(first)?.state).toBe("running");
    expect(queue.cancel(first)).toBe(true);
    await waitFor(() => events.includes("done second done"));
    expect(events).toEqual(["cancelled", "done second done"]);
    expect(queue.get(first)?.state).toBe("cancelled");
    expect(queue.cancel(first)).toBe(false);
  });
});
