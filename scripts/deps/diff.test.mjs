import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ffmpegPath } from "../../packages/core/dist/config.js";
import { alphaReport, framesAt, pixelDiff } from "./diff.mjs";

const dir = mkdtempSync(join(tmpdir(), "kf-diff-"));
const make = (name, args) => {
  const f = join(dir, name);
  const r = spawnSync(ffmpegPath(), ["-v", "error", "-y", ...args, f]);
  if (r.status !== 0) throw new Error(String(r.stderr));
  return f;
};
const card = (name, x) =>
  make(name, [
    "-f",
    "lavfi",
    "-i",
    "color=c=0x262b55:s=1920x1080",
    "-vf",
    `drawbox=x=${x}:y=400:w=300:h=200:color=0xe8d8c0:t=fill`,
    "-frames:v",
    "1",
  ]);

describe("pixelDiff", () => {
  it("finds nothing between a frame and itself", () => {
    const a = card("a.png", 800);
    expect(pixelDiff(a, a)).toEqual({ mean: 0, changed: 0 });
  });
  it("sees a card that moved", () => {
    const d = pixelDiff(card("b.png", 800), card("c.png", 900));
    expect(d.changed).toBeGreaterThan(0.01);
  });
});

describe("alphaReport", () => {
  it("reads ProRes 4444 alpha and how much of the frame is transparent", () => {
    const mov = make("o.mov", [
      "-f",
      "lavfi",
      "-i",
      "color=c=black@0.0:s=320x180:d=0.2,format=yuva444p12le",
      "-c:v",
      "prores_ks",
      "-profile:v",
      "4444",
      "-pix_fmt",
      "yuva444p12le",
    ]);
    const r = alphaReport(mov);
    expect(r.pixFmt).toBe("yuva444p12le");
    expect(r.transparentShare).toBeGreaterThan(0.99);
  });
});

describe("framesAt", () => {
  it("keeps frames at the size they are compared at, so golden references stay small", () => {
    const video = make("v.mp4", [
      "-f",
      "lavfi",
      "-i",
      "color=c=0x262b55:s=1920x1080:d=1",
      "-pix_fmt",
      "yuv420p",
    ]);
    const [f] = framesAt(video, [0.5], join(dir, "frames"));
    const probe = spawnSync(
      ffmpegPath().replace(/ffmpeg$/, "ffprobe"),
      ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", f],
      { encoding: "utf8" },
    );
    expect(probe.stdout.trim()).toBe("480,270");
  });
});
