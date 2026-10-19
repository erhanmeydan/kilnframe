import { describe, expect, it } from "vitest";
import { pickRange } from "../src/range";
import { rangeWatch, within } from "../src/range-watch";

const seq = { guid: "a", range: pickRange(1, 7, 60), endS: 60 };

describe("watching the in and out points", () => {
  it("updates only the range when the same sequence has new in and out points", () => {
    expect(rangeWatch(seq, { id: "a", inSeconds: 2, outSeconds: 9, endSeconds: 60 })).toEqual({
      kind: "range",
      range: pickRange(2, 9, 60),
      endS: 60,
    });
  });

  it("reads everything again for another sequence, and nothing when the range is the same", () => {
    expect(rangeWatch(seq, { id: "b", inSeconds: 2, outSeconds: 9, endSeconds: 60 })).toEqual({
      kind: "full",
    });
    expect(rangeWatch(null, { id: "a", inSeconds: 1, outSeconds: 7, endSeconds: 60 })).toEqual({
      kind: "full",
    });
    expect(rangeWatch(seq, { id: "a", inSeconds: 1, outSeconds: 7, endSeconds: 60 })).toEqual({
      kind: "same",
    });
  });

  it("gives up on a read the editor never answers, so the panel keeps looking", async () => {
    await expect(within(new Promise(() => undefined), 20)).rejects.toThrow(/did not answer/);
    await expect(within(Promise.resolve(7), 20)).resolves.toBe(7);
    await expect(within(Promise.reject(new Error("no sequence")), 20)).rejects.toThrow(
      "no sequence",
    );
  });
});
