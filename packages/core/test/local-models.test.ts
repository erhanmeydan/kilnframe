import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@huggingface/transformers";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadFromDisk } from "../src/local-models.js";
import { downloadVadModel, openVad } from "../src/pauses/vad.js";

// --- a voice model small enough to write here: an ONNX graph that says "speech, 0.75" whatever it hears ---

const varint = (n: number): number[] => {
  const out: number[] = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return out;
};
const bytes = (field: number, b: Uint8Array | number[]): number[] => [
  ...varint((field << 3) | 2),
  ...varint(b.length),
  ...b,
];
const str = (field: number, s: string): number[] => bytes(field, [...Buffer.from(s)]);
const int = (field: number, n: number): number[] => [...varint(field << 3), ...varint(n)];
const FLOAT = 1;
const INT64 = 7;

/** A float tensor of these dims and values (TensorProto: dims, data_type FLOAT, raw_data). */
const tensor = (dims: number[], values: number[]): number[] => [
  ...dims.flatMap((d) => int(1, d)),
  ...int(2, FLOAT),
  ...bytes(9, new Uint8Array(new Float32Array(values).buffer)),
];
/** A Constant node giving `name`. */
const constant = (name: string, dims: number[], values: number[]): number[] =>
  bytes(1, [
    ...str(2, name),
    ...str(3, name),
    ...str(4, "Constant"),
    ...bytes(5, [...str(1, "value"), ...bytes(5, tensor(dims, values)), ...int(20, 4)]),
  ]);
/** An input or output of this element type and shape. */
const valueInfo = (field: number, name: string, type: number, dims: number[]): number[] =>
  bytes(field, [
    ...str(1, name),
    ...bytes(
      2,
      bytes(1, [
        ...int(1, type),
        ...bytes(
          2,
          dims.flatMap((d) => bytes(1, int(1, d))),
        ),
      ]),
    ),
  ]);

const VAD = "onnx-community/silero-vad";

/** Silero VAD's inputs (input, sr, state) and outputs (output, stateN), at `<models>/<id>/onnx/model.onnx`. */
function writeVad(dir: string): void {
  const graph = [
    ...constant("output", [1, 1], [0.75]),
    ...constant("stateN", [2, 1, 128], new Array<number>(256).fill(0)),
    ...str(2, "vad"),
    ...valueInfo(11, "input", FLOAT, [1, 576]),
    ...valueInfo(11, "sr", INT64, []),
    ...valueInfo(11, "state", FLOAT, [2, 1, 128]),
    ...valueInfo(12, "output", FLOAT, [1, 1]),
    ...valueInfo(12, "stateN", FLOAT, [2, 1, 128]),
  ];
  const model = [...int(1, 8), ...bytes(7, graph), ...bytes(8, int(2, 13))];
  mkdirSync(join(dir, VAD, "onnx"), { recursive: true });
  writeFileSync(join(dir, VAD, "onnx", "model.onnx"), new Uint8Array(model));
}

// the network: every request fails, as on a computer with no connection, and is counted
const asked: string[] = [];
const offline = (url: unknown) => {
  asked.push(String(url));
  return Promise.reject(new TypeError("fetch failed"));
};
const before = { dir: process.env.KILNFRAME_MODELS_DIR, fetch: env.fetch };
beforeEach(() => {
  asked.length = 0;
  env.fetch = offline as typeof env.fetch;
  vi.stubGlobal("fetch", offline);
});
afterEach(() => {
  env.fetch = before.fetch;
  vi.unstubAllGlobals();
  if (before.dir === undefined) delete process.env.KILNFRAME_MODELS_DIR;
  else process.env.KILNFRAME_MODELS_DIR = before.dir;
});

test("Remove Pauses' voice model loads from the models folder and never touches the network", async () => {
  const models = mkdtempSync(join(tmpdir(), "kf-models-"));
  writeVad(models);
  process.env.KILNFRAME_MODELS_DIR = models;
  const remote = env.allowRemoteModels;
  const vad = await openVad(VAD);
  expect(await vad.push(new Float32Array(512))).toBeCloseTo(0.75, 5);
  // the companion's download of a model already there, with its progress, asks nothing either
  await downloadVadModel(VAD, () => undefined);
  expect(asked).toEqual([]);
  // left as it was for loads made elsewhere
  expect(env.allowRemoteModels).toBe(remote);
}, 60_000);

test("a model never fetched is fetched by the download that needs it", async () => {
  process.env.KILNFRAME_MODELS_DIR = mkdtempSync(join(tmpdir(), "kf-models-"));
  await expect(downloadVadModel(VAD)).rejects.toThrow(/Could not download/);
  expect(asked.some((u) => u.includes(VAD))).toBe(true);
}, 60_000);

test("loadFromDisk keeps the network off while it loads, and tries again with it only for a missing file", async () => {
  const models = mkdtempSync(join(tmpdir(), "kf-models-"));
  process.env.KILNFRAME_MODELS_DIR = models;
  const seen: boolean[] = [];
  const at = {
    cacheDir: null as string | null,
    localModelPath: "",
    allowLocalModels: false,
    allowRemoteModels: true,
  };
  const missing = Object.assign(new Error("model.onnx not found locally"), {
    name: "ModelFileNotFoundError",
  });
  const load = vi.fn(() => {
    seen.push(at.allowRemoteModels);
    return seen.length === 1 ? Promise.reject(missing) : Promise.resolve("model");
  });
  expect(await loadFromDisk(at, load)).toBe("model");
  expect(seen).toEqual([false, true]);
  expect(at).toMatchObject({
    cacheDir: models,
    localModelPath: models,
    allowLocalModels: true,
    allowRemoteModels: true,
  });
  // a broken model is not a missing one: one load, no network
  const broken = vi.fn(() => Promise.reject(new Error("bad model")));
  await expect(loadFromDisk(at, broken)).rejects.toThrow("bad model");
  expect(broken).toHaveBeenCalledTimes(1);
});
