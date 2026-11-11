import { describe, expect, it } from "vitest";
import { CompanionSession, type ServerMessage } from "../src/companion-session";

/** A session over a stand-in socket: records what is sent, and lets the test answer. */
function fakeSession() {
  const session = new CompanionSession();
  const sent: Record<string, unknown>[] = [];
  const inner = session as unknown as {
    client: { send(m: unknown): void } | null;
    dispatch(m: ServerMessage): void;
    closed(onClose: () => void): void;
  };
  inner.client = { send: (m) => sent.push(m as Record<string, unknown>) };
  const reply = (m: ServerMessage) => inner.dispatch(m);
  const close = () => inner.closed(() => undefined);
  return { session, sent, reply, close };
}

describe("companion session", () => {
  it("gives each request its own reply when two job.start replies arrive the other way round", async () => {
    const { session, sent, reply } = fakeSession();
    const preview = session.request(
      { type: "job.start", params: { kind: "captions-preview" } },
      "job.accepted",
    );
    const text = session.request(
      { type: "job.start", ref: "1", params: { kind: "captions-text" } },
      "job.accepted",
    );
    expect(sent).toHaveLength(2);
    const [a, b] = sent.map((m) => m.ref as string);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
    reply({ type: "job.accepted", jobId: "job-text", ref: b });
    reply({ type: "job.accepted", jobId: "job-preview", ref: a });
    expect((await preview).jobId).toBe("job-preview");
    expect((await text).jobId).toBe("job-text");
  });

  it("matches job.prepare replies by ref too, and still takes a reply without one", async () => {
    const { session, sent, reply } = fakeSession();
    const one = session.request({ type: "job.prepare", projectPath: "/p" }, "job.prepared");
    const two = session.request({ type: "job.prepare", projectPath: "/q" }, "job.prepared");
    reply({ type: "job.prepared", jobDir: "/q/job", ref: sent[1]!.ref });
    reply({ type: "job.prepared", jobDir: "/p/job", ref: sent[0]!.ref });
    expect((await one).jobDir).toBe("/p/job");
    expect((await two).jobDir).toBe("/q/job");
    // an older companion echoes nothing: the first reply is taken, as before
    const old = session.request({ type: "styles.list" }, "styles");
    reply({ type: "styles", styles: [] });
    expect((await old).styles).toEqual([]);
  });

  it("rejects only the request an error names", async () => {
    const { session, sent, reply } = fakeSession();
    const bad = session.request({ type: "job.start", params: {} }, "job.accepted");
    const good = session.request({ type: "job.start", params: {} }, "job.accepted");
    reply({ type: "error", message: "Invalid job", ref: sent[0]!.ref });
    reply({ type: "job.accepted", jobId: "job-2", ref: sent[1]!.ref });
    await expect(bad).rejects.toThrow("Invalid job");
    expect((await good).jobId).toBe("job-2");
  });

  it("leaves requests alone when an error names a plain send (a job.cancel on a finished job)", async () => {
    const { session, sent, reply } = fakeSession();
    const styles = session.request({ type: "styles.list" }, "styles");
    session.send({ type: "job.cancel", jobId: "gone" });
    const cancelRef = sent[1]!.ref as string;
    expect(cancelRef).toBeTruthy();
    expect(cancelRef).not.toBe(sent[0]!.ref);
    reply({ type: "error", message: "This job has already finished.", ref: cancelRef });
    reply({ type: "styles", styles: ["a"], ref: sent[0]!.ref });
    expect((await styles).styles).toEqual(["a"]);
  });

  it("takes an error without a ref as the answer when only one request waits (an older app)", async () => {
    const { session, sent, reply } = fakeSession();
    const models = session.request({ type: "models.list", provider: "antigravity" }, "models");
    reply({ type: "error", message: "Antigravity CLI could not reach Google." });
    await expect(models).rejects.toThrow("could not reach Google");
    // with two waiting, nobody can tell whose it is: both keep waiting for their own reply
    const a = session.request({ type: "styles.list" }, "styles");
    const b = session.request({ type: "styles.list" }, "styles");
    reply({ type: "error", message: "Something failed" });
    reply({ type: "styles", styles: ["a"], ref: sent[1]!.ref });
    reply({ type: "styles", styles: ["b"], ref: sent[2]!.ref });
    expect((await a).styles).toEqual(["a"]);
    expect((await b).styles).toEqual(["b"]);
  });

  it("fails waiting requests and running jobs when the connection closes", async () => {
    const { session, sent, reply, close } = fakeSession();
    const seen: ServerMessage[] = [];
    session.on((m) => seen.push(m));
    const start = session.request({ type: "job.start", params: {} }, "job.accepted");
    reply({ type: "job.accepted", jobId: "job-1", ref: sent[0]!.ref });
    await start;
    reply({ type: "job.progress", jobId: "job-2", message: "x" });
    reply({ type: "job.done", jobId: "job-2", result: {} });
    const waiting = session.request({ type: "styles.list" }, "styles");
    close();
    await expect(waiting).rejects.toThrow();
    const lost = seen.filter((m) => m.type === "job.error");
    // the finished job hears nothing more; the running one ends as lost
    expect(lost.map((m) => m.jobId)).toEqual(["job-1"]);
    expect(lost[0]!.connectionLost).toBe(true);
    expect(session.connected).toBe(false);
  });
});
