import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { audioSeconds, readAudio, SR, writeAudio } from "../src/music/score/audio-io.js";

describe("music audio in and out", () => {
  it("reads back what it wrote: same length, same samples", () => {
    const file = join(mkdtempSync(join(tmpdir(), "kf-io-")), "a.wav");
    const x = new Float32Array(3 * SR).map((_, i) => 0.25 * Math.sin((2 * Math.PI * 220 * i) / SR));
    writeAudio(file, [x, x.slice()]);
    const back = readAudio(file);
    expect(back).toHaveLength(2);
    expect(back[0]!.length).toBe(3 * SR);
    expect(back[0]![1000]!).toBeCloseTo(x[1000]!, 3);
  });

  it("tells a piece's length from its header, without decoding it", () => {
    const dir = mkdtempSync(join(tmpdir(), "kf-io-"));
    const file = join(dir, "b.wav");
    const x = new Float32Array(Math.round(2.5 * SR));
    writeAudio(file, [x, x.slice()]);
    expect(audioSeconds(file)).toBeCloseTo(2.5, 1);
    expect(audioSeconds(join(dir, "missing.wav"))).toBeNull();
  });
});
