import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { ffmpegPath } from "./config.js";
import { sceneMode, type Plan } from "./schemas/plan.js";
import { loadStyle } from "./styles.js";

/** Measured at this size: enough for drawings, quick to walk. */
const W = 480;
const H = 270;
/** Smaller than this (in pixels at 480x270) is grain, a halftone dot or a stray mark, not a drawing. */
const MIN_AREA = 60;
/** A shape wider or taller than this share of the frame bleeds off on purpose (a band, a full-bleed panel). */
const MAX_WIDE = 0.35;
const MAX_TALL = 0.5;

/**
 * Whether a frame has a small drawing that runs off one of its edges: an icon, a sheet or a word cut in half
 * (14 Oct 2026, a document half outside the frame in a whiteboard scene). Large shapes across an edge are a
 * style's own bleed (cropped kinetic type, a collage photo), so only small ones count. An overlay is read by
 * its alpha; a fullscreen frame by how far each pixel stands out from its own neighbourhood.
 * `rgba` is W x H x 4 bytes.
 */
export function cutAtEdge(rgba: Buffer, width: number, height: number): boolean {
  const n = width * height;
  let transparent = 0;
  for (let i = 0; i < n; i++) if (rgba[i * 4 + 3]! < 128) transparent++;
  const byAlpha = transparent > n * 0.2;
  // the ground is read around each pixel, not as one colour: a stage lit in the middle and dark in the
  // corners is ground too. A pixel is ink where it stands out from its neighbourhood (a box of 13 x 13)
  const luma = new Float32Array(n);
  for (let i = 0; i < n; i++)
    luma[i] = 0.299 * rgba[i * 4]! + 0.587 * rgba[i * 4 + 1]! + 0.114 * rgba[i * 4 + 2]!;
  const sum = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      sum[(y + 1) * (width + 1) + x + 1] =
        luma[y * width + x]! +
        sum[y * (width + 1) + x + 1]! +
        sum[(y + 1) * (width + 1) + x]! -
        sum[y * (width + 1) + x]!;
  const R = 6;
  const around = (x: number, y: number) => {
    const x0 = Math.max(0, x - R);
    const y0 = Math.max(0, y - R);
    const x1 = Math.min(width, x + R + 1);
    const y1 = Math.min(height, y + R + 1);
    const total =
      sum[y1 * (width + 1) + x1]! -
      sum[y0 * (width + 1) + x1]! -
      sum[y1 * (width + 1) + x0]! +
      sum[y0 * (width + 1) + x0]!;
    return total / ((x1 - x0) * (y1 - y0));
  };
  const ink = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (byAlpha) ink[i] = rgba[i * 4 + 3]! >= 128 ? 1 : 0;
    else {
      const x = i % width;
      ink[i] = Math.abs(luma[i]! - around(x, (i - x) / width)) > 40 ? 1 : 0;
    }
  }
  // each shape that touches an edge, walked once
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  const edge = (i: number) => {
    const x = i % width;
    const y = (i - x) / width;
    return x === 0 || y === 0 || x === width - 1 || y === height - 1;
  };
  for (let start = 0; start < n; start++) {
    if (!ink[start] || seen[start] || !edge(start)) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;
    while (head < tail) {
      const i = queue[head++]!;
      const x = i % width;
      const y = (i - x) / width;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (const j of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i - width, i + width]) {
        if (j < 0 || j >= n || !ink[j] || seen[j]) continue;
        seen[j] = 1;
        queue[tail++] = j;
      }
    }
    const small = maxX - minX + 1 <= width * MAX_WIDE && maxY - minY + 1 <= height * MAX_TALL;
    if (tail >= MIN_AREA && small) return true;
  }
  return false;
}

function rgbaOf(png: string): Buffer | null {
  const r = spawnSync(
    ffmpegPath(),
    [
      "-v",
      "error",
      "-i",
      png,
      "-vf",
      `scale=${W}:${H}:flags=area`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "-",
    ],
    { maxBuffer: 1 << 24 },
  );
  return r.status === 0 && r.stdout.length === W * H * 4 ? r.stdout : null;
}

/** Whether a style crops at the frame's edge on purpose (tokens.json layout.bleedOffEdges). */
export function bleedsOffEdges(tokensJson: string): boolean {
  try {
    return (
      (JSON.parse(tokensJson) as { layout?: { bleedOffEdges?: unknown } }).layout?.bleedOffEdges ===
      true
    );
  } catch {
    return false;
  }
}

/**
 * The scenes whose review still has a small drawing cut by the frame's edge. A note for the editor, not a
 * repair: some styles bleed off the edge on purpose. Overlay scenes are read from their transparent still.
 */
export function edgeCutScenes(plan: Plan, stills: string[], stillsDir: string): string[] {
  try {
    if (bleedsOffEdges(loadStyle(plan.style).tokensJson)) return [];
  } catch {
    // a style that cannot be read: the scenes are looked at as usual
  }
  const cut: string[] = [];
  plan.scenes.forEach((s, i) => {
    const still = stills[i];
    if (!still) return;
    const alpha = join(stillsDir, "alpha", basename(still));
    const file = sceneMode(plan, s) === "overlay" && existsSync(alpha) ? alpha : still;
    const rgba = rgbaOf(file);
    if (rgba && cutAtEdge(rgba, W, H)) cut.push(s.id);
  });
  return cut;
}
