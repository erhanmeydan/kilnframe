import { describe, expect, it } from "vitest";
import { bleedsOffEdges, cutAtEdge } from "../src/edges.js";

const W = 480;
const H = 270;
/** An RGBA frame of paper colour with dark rectangles drawn on it. */
function frame(rects: [number, number, number, number][], alpha = false): Buffer {
  const b = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) b.set(alpha ? [0, 0, 0, 0] : [240, 236, 228, 255], i * 4);
  for (const [x0, y0, w, h] of rects)
    for (let y = y0; y < y0 + h; y++)
      for (let x = x0; x < x0 + w; x++) b.set([30, 30, 30, 255], (y * W + x) * 4);
  return b;
}

describe("elements cut at the frame's edge", () => {
  it("finds a small drawing that runs off an edge", () => {
    expect(cutAtEdge(frame([[0, 100, 20, 40]]), W, H)).toBe(true);
    expect(cutAtEdge(frame([[200, 0, 40, 25]]), W, H)).toBe(true);
  });

  it("leaves a drawing inside the frame, a band across it and specks of texture alone", () => {
    expect(cutAtEdge(frame([[100, 100, 40, 40]]), W, H)).toBe(false);
    expect(cutAtEdge(frame([[0, 200, 480, 30]]), W, H)).toBe(false);
    expect(
      cutAtEdge(
        frame([
          [0, 50, 3, 3],
          [477, 90, 3, 3],
          [240, 0, 4, 2],
        ]),
        W,
        H,
      ),
    ).toBe(false);
  });

  it("does not take a dark ground that brightens towards the middle for a drawing", () => {
    const b = Buffer.alloc(W * H * 4);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        // an even ground that darkens smoothly into the four corners (a lit stage)
        const cx = Math.min(x, W - 1 - x);
        const cy = Math.min(y, H - 1 - y);
        const r = Math.hypot(cx, cy);
        const v = Math.round(r >= 70 ? 110 : 30 + (80 * r) / 70);
        b.set([v, v, v + 30, 255], (y * W + x) * 4);
      }
    expect(cutAtEdge(b, W, H)).toBe(false);
  });

  it("reads an overlay by its alpha: a card cut at the edge, not the clear frame", () => {
    expect(cutAtEdge(frame([[460, 120, 20, 50]], true), W, H)).toBe(true);
    expect(cutAtEdge(frame([], true), W, H)).toBe(false);
  });

  it("leaves a style alone that crops at the frame's edge on purpose", () => {
    expect(bleedsOffEdges('{"layout":{"bleedOffEdges":true}}')).toBe(true);
    expect(bleedsOffEdges('{"layout":{"scale":"big"}}')).toBe(false);
    expect(bleedsOffEdges("not json")).toBe(false);
  });
});
