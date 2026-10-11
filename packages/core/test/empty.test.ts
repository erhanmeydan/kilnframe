import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ffmpegPath } from "../src/config.js";
import { looksEmpty } from "../src/empty.js";

const dir = mkdtempSync(join(tmpdir(), "kf-empty-"));

function png(name: string, source: string, vf: string[]): string {
  const file = join(dir, name);
  const r = spawnSync(ffmpegPath(), [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    source,
    "-vf",
    vf.join(","),
    "-frames:v",
    "1",
    file,
  ]);
  if (r.status !== 0) throw new Error(String(r.stderr));
  return file;
}

// a navy 3D stage with nothing on it, as a lost camera renders it: a soft gradient
const stage = (name: string, withBox: boolean) =>
  png(name, "gradients=s=1920x1080:c0=0x262b55:c1=0x1c2040:x0=0:y0=0:x1=1920:y1=1080", [
    "format=rgb24",
    ...(withBox ? ["drawbox=x=820:y=420:w=220:h=180:color=0xe8d8c0:t=fill"] : []),
  ]);
// a transparent overlay, empty or with one small card
const overlay = (name: string, withCard: boolean) =>
  png(name, "color=c=black@0.0:s=1920x1080,format=rgba", [
    // geq sets the alpha itself: drawbox would leave the card transparent
    withCard
      ? "geq=r=255:g=255:b=255:a='if(between(X,1400,1759)*between(Y,860,969),255,0)'"
      : "null",
  ]);

describe("looksEmpty", () => {
  it("finds a fullscreen scene that shows only its background", () => {
    expect(looksEmpty([stage("blank.png", false)], "fullscreen")).toBe(true);
  });

  it("leaves a fullscreen scene with one plain shape alone", () => {
    expect(looksEmpty([stage("box.png", true)], "fullscreen")).toBe(false);
  });

  it("finds an overlay that draws nothing, and keeps one with a small card", () => {
    expect(looksEmpty([overlay("clear.png", false)], "overlay")).toBe(true);
    expect(looksEmpty([overlay("card.png", true)], "overlay")).toBe(false);
  });

  it("needs every frame to be empty: content in one of them is enough", () => {
    expect(looksEmpty([stage("blank2.png", false), stage("box2.png", true)], "fullscreen")).toBe(
      false,
    );
  });
});
