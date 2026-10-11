import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ffmpegPath } from "../src/config.js";
import { fullness, pickStill, stillCandidates } from "../src/stages/still-pick.js";

describe("stillCandidates", () => {
  it("spreads a few times from the usual still to just before the scene ends, keeping the usual one", () => {
    // a scene from 0 to 5 s whose usual still is at 3 s
    const times = stillCandidates([{ startS: 0, endS: 5 }], [3])[0] as number[];
    expect(times[0]).toBeCloseTo(3);
    expect(times.at(-1)).toBeCloseTo(4.8);
    expect(times.length).toBeGreaterThanOrEqual(4);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("gives a scene too short to sample just its usual still", () => {
    expect(stillCandidates([{ startS: 0, endS: 1 }], [0.8])).toEqual([[0.8]]);
  });
});

describe("pickStill", () => {
  it("takes the fullest frame: the text written, the exit not begun", () => {
    // typing until the third sample, an exit in the last one
    expect(pickStill([3, 3.5, 4, 4.5], [10, 18, 25, 12], 3)).toBe(2);
  });

  it("keeps the usual still when another is barely fuller", () => {
    expect(pickStill([3, 3.5, 4], [25, 25.3, 25.2], 3)).toBe(0);
  });
});

describe("fullness", () => {
  const dir = mkdtempSync(join(tmpdir(), "kf-still-"));
  /** A 640x360 frame: plain, with one box, or with five, like text being written. */
  const frame = (name: string, boxes: number) => {
    const file = join(dir, name);
    const draw = Array.from(
      { length: boxes },
      (_, i) => `drawbox=x=${60 + i * 100}:y=150:w=70:h=40:color=black:t=4`,
    );
    const vf = ["format=rgb24", ...draw].join(",");
    const r = spawnSync(ffmpegPath(), [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=0xf0e8dc:s=640x360",
      "-vf",
      vf,
      "-frames:v",
      "1",
      file,
    ]);
    if (r.status !== 0) throw new Error(String(r.stderr));
    return file;
  };

  it("grows as more is drawn", () => {
    const empty = fullness(frame("empty.png", 0));
    const one = fullness(frame("one.png", 1));
    const five = fullness(frame("five.png", 5));
    expect(empty).toBeLessThan(one);
    expect(one).toBeLessThan(five);
  });
});
