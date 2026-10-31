import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ffmpegPath } from "../src/config.js";
import { faintShare, faintShareOf } from "../src/haze.js";

const dir = mkdtempSync(join(tmpdir(), "kilnframe-haze-"));

/** A transparent PNG (1920x1080 unless given) with one white box of the given alpha (0 to 255) in it. */
function overlayPng(
  name: string,
  x: number,
  y: number,
  w: number,
  h: number,
  alpha: number,
  size = "1920x1080",
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
    `color=c=white:s=${size},format=rgba`,
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

  it("leaves a clean portrait overlay alone", () => {
    // 2160x3840 does not divide into 480x270; FFmpeg's Windows build read its clear pixels as faint
    expect(
      faintShare(overlayPng("portrait.png", 200, 300, 1700, 400, 255, "2160x3840")),
    ).toBeLessThan(0.03);
  });
});

describe("faintShareOf", () => {
  it("reads a clear frame of any size as clear", () => {
    expect(faintShareOf(new Uint8Array(2160 * 3840), 2160, 3840)).toBe(0);
    expect(faintShareOf(new Uint8Array(1080 * 1080), 1080, 1080)).toBe(0);
  });

  it("finds a faint layer in a portrait frame", () => {
    expect(faintShareOf(new Uint8Array(2160 * 3840).fill(6), 2160, 3840)).toBe(1);
  });

  it("leaves a solid card in a portrait frame alone", () => {
    const a = new Uint8Array(2160 * 3840);
    for (let y = 300; y < 700; y++) a.fill(255, y * 2160 + 200, y * 2160 + 1900);
    expect(faintShareOf(a, 2160, 3840)).toBeLessThan(0.03);
  });
});
