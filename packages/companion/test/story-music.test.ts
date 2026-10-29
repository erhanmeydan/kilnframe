import { describe, expect, it } from "vitest";
import { musicOrNote } from "../src/runner.js";

describe("musicOrNote", () => {
  it("passes the music through when it is made", async () => {
    expect(await musicOrNote(async () => ({ file: "/m.wav", priceUsd: 0.1 }))).toEqual({
      music: { file: "/m.wav", priceUsd: 0.1 },
      musicError: null,
    });
  });

  it("keeps the narration when the music fails, with the first line of the reason", async () => {
    const r = await musicOrNote(async () => {
      throw new Error("Lyria failed (429): limit: 0 requests per day on Free Tier\nmore detail");
    });
    expect(r.music).toBeNull();
    expect(r.musicError).toBe("Lyria failed (429): limit: 0 requests per day on Free Tier");
  });
});
