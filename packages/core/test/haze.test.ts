import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ffmpegPath } from "../src/config.js";
import { faintShare } from "../src/haze.js";

const dir = mkdtempSync(join(tmpdir(), "kilnframe-haze-"));

/** A transparent 1920x1080 PNG with one white box of the given alpha (0 to 255) in it. */
function overlayPng(
  name: string,
  x: number,
  y: number,
  w: number,
  h: number,
  alpha: number,
): string {
  const file = join(dir, name);
  const inBox = `between(X,${x},${x + w - 1})*between(Y,${y},${y + h - 1})`;
  const r = spawnSync(ffmpegPath(), [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=white:s=1920x1080,format=rgba",
    "-vf",
    `geq=r=255:g=255:b=255:a='if(${inBox},${alpha},0)'`,
    "-frames:v",
    "1",
    file,
  ]);
  if (r.status !== 0) throw new Error(String(r.stderr));
  return file;
}

describe("faintShare", () => {
  it("finds a grain-like layer over the whole frame", () => {
    expect(faintShare(overlayPng("grain.png", 0, 0, 1920, 1080, 6))).toBeGreaterThan(0.9);
  });

  it("finds a ghost card", () => {
    expect(faintShare(overlayPng("ghost.png", 1380, 100, 420, 440, 6))).toBeGreaterThan(0.03);
  });

  it("leaves a clearly visible card alone", () => {
    expect(faintShare(overlayPng("card.png", 1380, 100, 420, 440, 230))).toBeLessThan(0.03);
  });
});
