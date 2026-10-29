import { describe, expect, it } from "vitest";
import { CompanionSession, type ServerMessage } from "../src/companion-session";

/** A session over a stand-in socket: records what is sent, and lets the test answer. */
function fakeSession() {
  const session = new CompanionSession();
  const sent: Record<string, unknown>[] = [];
  const inner = session as unknown as {
    client: { send(m: unknown): void };
    listeners: Set<(m: ServerMessage) => void>;
  };
  inner.client = { send: (m) => sent.push(m as Record<string, unknown>) };
  const reply = (m: ServerMessage) => [...inner.listeners].forEach((l) => l(m));
  return { session, sent, reply };
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
});
