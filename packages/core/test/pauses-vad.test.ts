import { Tensor } from "@huggingface/transformers";
import { expect, test } from "vitest";
import { loadDefaults } from "../src/config.js";
import {
  VAD_FRAME,
  VAD_FRAME_S,
  VAD_SAMPLE_RATE,
  openVad,
  pausesBetween,
  speechFromProbabilities,
  type VadModel,
} from "../src/pauses/vad.js";

test("speech from the voice model's frames: hysteresis keeps a soft syllable in, short blips and pauses do not count", () => {
  const f = (s: string) =>
    Float32Array.from([...s].map((c) => (c === "#" ? 0.9 : c === "+" ? 0.4 : 0.05)));
  // speech, a soft dip (+) that stays speech, a 2-frame pause (64 ms, joined), then a lone frame (a click)
  const spans = speechFromProbabilities(f("..######++####..####.........#........"));
  expect(spans).toHaveLength(1);
  expect(spans[0]?.[0]).toBeCloseTo(2 * VAD_FRAME_S);
  expect(spans[0]?.[1]).toBeCloseTo(20 * VAD_FRAME_S);
});

test("the pauses between speech, before the first and after the last", () => {
  expect(
    pausesBetween(
      [
        [1, 2],
        [3, 4],
      ],
      5,
    ),
  ).toEqual([
    [0, 1],
    [2, 3],
    [4, 5],
  ]);
});

test("frames are 32 ms of 16 kHz audio", () => {
  expect(VAD_SAMPLE_RATE).toBe(16000);
  expect(VAD_FRAME).toBe(512);
  expect(VAD_FRAME_S).toBeCloseTo(0.032);
});

test("the voice model's id comes from the defaults", () => {
  expect(loadDefaults().pauses.vadModel).toBe("onnx-community/silero-vad");
});

test("a stream carries the model's state and 64 samples of context from frame to frame", async () => {
  const seen: { input: Float32Array; dims: number[]; state: Float32Array; sr: bigint }[] = [];
  let calls = 0;
  const fake: VadModel = async ({ input, state, sr }) => {
    calls++;
    seen.push({
      input: Float32Array.from(input.data as Float32Array),
      dims: input.dims,
      state: Float32Array.from(state.data as Float32Array),
      sr: (sr.data as BigInt64Array)[0] as bigint,
    });
    // the next state marks how many frames were read; the probability is the frame's first sample
    const next = new Float32Array(2 * 128).fill(calls);
    return {
      output: new Tensor(
        "float32",
        Float32Array.of((input.data as Float32Array)[64] as number),
        [1, 1],
      ),
      stateN: new Tensor("float32", next, [2, 1, 128]),
    };
  };
  const vad = await openVad("any", async () => fake);
  const frame = (from: number) =>
    Float32Array.from({ length: VAD_FRAME }, (_, i) => (from + i) / 1e4);
  expect(await vad.push(frame(0))).toBeCloseTo(0);
  expect(await vad.push(frame(512))).toBeCloseTo(0.0512);
  // a short last frame is padded with silence
  await vad.push(Float32Array.of(0.5, 0.5));

  expect(seen[0]?.dims).toEqual([1, 64 + VAD_FRAME]);
  expect(seen[0]?.sr).toBe(16000n);
  // the first frame has silence for context and a zero state
  expect([...(seen[0]?.input.subarray(0, 64) ?? [])].every((v) => v === 0)).toBe(true);
  expect([...(seen[0]?.state ?? [])].every((v) => v === 0)).toBe(true);
  // the second frame's context is the last 64 samples of the first, and its state the first's result
  expect(seen[1]?.input[0]).toBeCloseTo(448 / 1e4);
  expect(seen[1]?.input[63]).toBeCloseTo(511 / 1e4);
  expect(seen[1]?.input[64]).toBeCloseTo(512 / 1e4);
  expect(seen[1]?.state[0]).toBe(1);
  expect(seen[2]?.state[0]).toBe(2);
  expect(seen[2]?.input[63]).toBeCloseTo(1023 / 1e4);
  expect(seen[2]?.input[65]).toBe(0.5);
  expect(seen[2]?.input[66]).toBe(0);
  // a frame longer than the model reads is a caller's mistake
  await expect(vad.push(new Float32Array(VAD_FRAME + 1))).rejects.toThrow(/512/);
});
