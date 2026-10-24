import type { OutputFormat } from "./schemas/plan.js";

export interface SafeArea {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * Default safe areas in pixels, scaled from a 1080 px short edge. Portrait comes from the kil-lacivert
 * channel rules (72 / 150 / 250); landscape and square are provisional until the first real renders.
 */
export function safeArea(format: OutputFormat, width: number, height: number): SafeArea {
  const k = Math.min(width, height) / 1080;
  const px = (v: number) => Math.round(v * k);
  switch (format) {
    case "portrait":
      return { top: px(150), right: px(72), bottom: px(250), left: px(72) };
    case "square":
      return { top: px(96), right: px(72), bottom: px(140), left: px(72) };
    case "landscape":
      return { top: px(80), right: px(110), bottom: px(120), left: px(110) };
  }
}

/** Portrait captions sit with their centre at this share of the height (Reels and Shorts keep the bottom). */
export const PORTRAIT_CENTRE = 0.685;
