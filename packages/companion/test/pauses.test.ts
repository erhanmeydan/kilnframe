import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSpeech, loadDefaults } from "@kilnframe/core";
import type * as Core from "@kilnframe/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClientMessageSchema, JobParamsSchema, MemoryKeyStore } from "../src/index.js";
import { pipelineRunner } from "../src/runner.js";

vi.mock("@kilnframe/core", async (importOriginal) => {
  const core = await importOriginal<typeof Core>();
  return { ...core, findSpeech: vi.fn() };
});

const dir = () => mkdtempSync(join(tmpdir(), "kf-pauses-"));

beforeEach(() => {
  vi.mocked(findSpeech).mockReset();
});

describe("pauses protocol", () => {
  const job = { kind: "pauses-find", audioPath: "/a/seq.wav", outDir: "/a/pauses" };
  const parse = (o: object) => JobParamsSchema.safeParse({ ...job, ...o }).success;

  it("accepts the job with or without a range", () => {
    expect(parse({})).toBe(true);
    expect(parse({ rangeStartS: 12, rangeEndS: 340 })).toBe(true);
    expect(parse({ rangeEndS: 340 })).toBe(true);
  });

  it("refuses a job without a file or folder, or with a range backwards", () => {
    expect(parse({ audioPath: "" })).toBe(false);
    expect(parse({ outDir: "" })).toBe(false);
    expect(parse({ rangeStartS: -1 })).toBe(false);
    expect(parse({ rangeEndS: 0 })).toBe(false);
    expect(parse({ rangeStartS: 50, rangeEndS: 40 })).toBe(false);
  });

  const cuts = {
    type: "pauses.cuts",
    speech: [
      [1, 2],
      [3, 4],
    ],
    durationS: 5,
    strictness: 0.5,
    keepLongS: null,
  };
  const ask = (o: object) => ClientMessageSchema.safeParse({ ...cuts, ...o }).success;

  it("accepts the pauses.cuts request", () => {
    expect(ask({})).toBe(true);
    expect(ask({ keepLongS: 10, ref: "r1" })).toBe(true);
    expect(ask({ speech: [] })).toBe(true);
  });

  it("refuses strictness outside 0..1, broken spans and too many spans", () => {
    expect(ask({ strictness: 1.5 })).toBe(false);
    expect(ask({ strictness: -0.1 })).toBe(false);
    expect(ask({ strictness: undefined })).toBe(false);
    expect(ask({ speech: [[1]] })).toBe(false);
    expect(ask({ speech: [[-1, 2]] })).toBe(false);
    expect(ask({ durationS: 0 })).toBe(false);
    expect(ask({ keepLongS: 0 })).toBe(false);
    expect(ask({ speech: Array.from({ length: 20_001 }, (_, i) => [i, i + 0.5]) })).toBe(false);
  });
});

describe("pauses-find", () => {
  const params = (outDir: string, o: object = {}) =>
    JobParamsSchema.parse({ kind: "pauses-find", audioPath: "/a/seq.wav", outDir, ...o });

  it("listens to the range with the default voice model, returns the speech and keeps it on disk", async () => {
    vi.mocked(findSpeech).mockImplementation(async (o) => {
      o.onProgress?.(0.4);
      o.onProgress?.(1);
      return {
        speech: [
          [0.5, 2],
          [3, 7.25],
        ],
        durationS: 8,
      };
    });
    const outDir = join(dir(), "pauses");
    const progress: string[] = [];
    const r = await pipelineRunner(new MemoryKeyStore())(
      params(outDir, { rangeStartS: 10, rangeEndS: 18 }),
      { progress: (m) => progress.push(m), signal: new AbortController().signal },
    );
    expect(r).toEqual({
      kind: "pauses-find",
      speech: [
        [0.5, 2],
        [3, 7.25],
      ],
      durationS: 8,
    });
    expect(vi.mocked(findSpeech).mock.calls[0]?.[0]).toMatchObject({
      audioPath: "/a/seq.wav",
      rangeStartS: 10,
      rangeEndS: 18,
      model: loadDefaults().pauses.vadModel,
    });
    expect(progress).toContain("Listening to the speech, 40%");
    expect(JSON.parse(readFileSync(join(outDir, "speech.json"), "utf8"))).toEqual(r);
  });

  it("cancel aborts the listening", async () => {
    let seen: AbortSignal | undefined;
    vi.mocked(findSpeech).mockImplementation(
      (o) =>
        new Promise((_, reject) => {
          seen = o.signal;
          o.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const ac = new AbortController();
    const run = pipelineRunner(new MemoryKeyStore())(params(dir()), {
      progress: () => {},
      signal: ac.signal,
    });
    await vi.waitFor(() => expect(seen).toBeDefined());
    ac.abort();
    await expect(run).rejects.toThrow(/aborted/);
    expect(seen?.aborted).toBe(true);
  });
});
