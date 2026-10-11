// How far a render moved between two versions: frames, pixel difference, side-by-side images, alpha.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ffmpegPath } from "../../packages/core/dist/config.js";

const ff = (args) => {
  const r = spawnSync(ffmpegPath(), ["-v", "error", "-y", ...args], { maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

export function framesAt(video, times, outDir) {
  mkdirSync(outDir, { recursive: true });
  return times.map((t, i) => {
    const f = join(outDir, `f${String(i).padStart(2, "0")}-${t.toFixed(2)}.png`);
    ff(["-ss", String(t), "-i", video, "-frames:v", "1", f]);
    return f;
  });
}

const rgba = (png) =>
  ff(["-i", png, "-vf", "scale=480:270:flags=area,format=rgba", "-f", "rawvideo", "-"]);

/** Mean absolute difference (0..255) over RGBA at 480x270, and the share of pixels that changed visibly. */
export function pixelDiff(a, b) {
  const x = rgba(a);
  const y = rgba(b);
  let sum = 0;
  let changed = 0;
  for (let p = 0; p < x.length; p += 4) {
    let max = 0;
    for (let c = 0; c < 4; c++) {
      const d = Math.abs(x[p + c] - y[p + c]);
      sum += d;
      if (d > max) max = d;
    }
    if (max > 16) changed++;
  }
  const px = x.length / 4;
  return {
    mean: Math.round((sum / x.length) * 100) / 100,
    changed: Math.round((changed / px) * 10000) / 10000,
  };
}

/** Old, new and their difference amplified four times, side by side. */
export function sideBySide(a, b, out) {
  mkdirSync(join(out, ".."), { recursive: true });
  ff([
    "-i",
    a,
    "-i",
    b,
    "-filter_complex",
    "[0:v]scale=640:-2,format=rgb24,split[o1][o2];[1:v]scale=640:-2,format=rgb24,split[n1][n2];" +
      "[o1][n1]blend=all_mode=difference,lutrgb=r=val*4:g=val*4:b=val*4[d];[o2][n2][d]hstack=3",
    "-frames:v",
    "1",
    out,
  ]);
}

/** The video's pixel format and how much of its first frame is fully transparent. */
export function alphaReport(video) {
  const probe = spawnSync(
    ffmpegPath().replace(/ffmpeg(\.exe)?$/, "ffprobe$1"),
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=pix_fmt",
      "-of",
      "csv=p=0",
      video,
    ],
    { encoding: "utf8" },
  );
  const alpha = ff([
    "-i",
    video,
    "-frames:v",
    "1",
    "-vf",
    "alphaextract,scale=480:270:flags=area",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "gray",
    "-",
  ]);
  let clear = 0;
  for (const a of alpha) if (a < 8) clear++;
  return { pixFmt: probe.stdout.trim(), transparentShare: clear / alpha.length };
}
