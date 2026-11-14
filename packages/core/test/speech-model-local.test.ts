import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as Transformers from "@huggingface/transformers";
import { afterEach, expect, test, vi } from "vitest";

// the pipeline stands in for the 1 GB speech model: it records how transformers.js was set when it was asked
const calls: { remote: boolean; local: boolean; path: string }[] = [];
let missing = false;
vi.mock("@huggingface/transformers", async (original) => {
  const real = await original<typeof Transformers>();
  return {
    ...real,
    pipeline: vi.fn(() => {
      calls.push({
        remote: real.env.allowRemoteModels,
        local: real.env.allowLocalModels,
        path: real.env.localModelPath,
      });
      if (missing && calls.length === 1)
        return Promise.reject(
          Object.assign(new Error("encoder_model_quantized.onnx not found locally"), {
            name: "ModelFileNotFoundError",
          }),
        );
      return Promise.resolve({ model: {} });
    }),
  };
});

const { loadSpeechModel } = await import("../src/stages/transcribe.js");
const defaults = {
  whisper: {
    model: "onnx-community/whisper-small_timestamped",
    dtype: { encoder_model: "q8", decoder_model_merged: "q8" },
    chunkLengthS: 30,
  },
} as never;
const dir = process.env.KILNFRAME_MODELS_DIR;
afterEach(() => {
  calls.length = 0;
  missing = false;
  if (dir === undefined) delete process.env.KILNFRAME_MODELS_DIR;
  else process.env.KILNFRAME_MODELS_DIR = dir;
});

test("the speech model on disk is loaded from the models folder with the network off", async () => {
  const models = mkdtempSync(join(tmpdir(), "kf-models-"));
  process.env.KILNFRAME_MODELS_DIR = models;
  await loadSpeechModel(defaults);
  expect(calls).toEqual([{ remote: false, local: true, path: models }]);
});

test("a speech model not yet on disk is fetched by the transcription or download that asked for it", async () => {
  process.env.KILNFRAME_MODELS_DIR = mkdtempSync(join(tmpdir(), "kf-models-"));
  missing = true;
  await loadSpeechModel(defaults);
  expect(calls.map((c) => c.remote)).toEqual([false, true]);
});
