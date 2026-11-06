import type { CaptionColors, CaptionStyleId } from "./types.js";

export type { CaptionColors, CaptionStyleId } from "./types.js";

export interface CaptionLook {
  id: CaptionStyleId;
  name: { en: string; tr: string };
  /** Font file path relative to vendor/fonts. */
  font: string;
  /** Italic file used for the active word, when the look has one. */
  fontActive?: string;
  /** CSS weight for the text; static font files must match it. */
  weight: number;
  /** Weight of the active word when it differs. */
  weightActive?: number;
  colors: CaptionColors;
  uppercase: boolean;
  /** Written in lower case (kept names stay as written). */
  lowercase?: boolean;
  maxLines: 1 | 2;
  maxChars: { portrait: number; landscape: number; square: number };
}

export const CAPTION_LOOKS: Record<CaptionStyleId, CaptionLook> = {
  "kil-lacivert": {
    id: "kil-lacivert",
    name: { en: "Kil Navy", tr: "Kil Lacivert" },
    font: "sora/Sora-Variable.ttf",
    weight: 600,
    colors: { text: "#efe8dd", accent: "#d9875f", box: "#1c2537" },
    uppercase: false,
    maxLines: 2,
    maxChars: { portrait: 16, landscape: 28, square: 20 },
  },
  loud: {
    id: "loud",
    name: { en: "Loud", tr: "Loud" },
    font: "anton/Anton-Regular.ttf",
    weight: 400,
    colors: { text: "#ffffff", accent: "#ffd23f" },
    uppercase: true,
    maxLines: 2,
    maxChars: { portrait: 14, landscape: 24, square: 18 },
  },
  dinamik: {
    id: "dinamik",
    name: { en: "Dynamic", tr: "Dinamik" },
    font: "montserrat/Montserrat-Variable.ttf",
    weight: 800,
    colors: { text: "#ffffff", accent: "#ffffff", box: "#000000" },
    uppercase: false,
    maxLines: 2,
    maxChars: { portrait: 16, landscape: 28, square: 20 },
  },
  hap: {
    id: "hap",
    name: { en: "Pill", tr: "Hap" },
    font: "poppins/Poppins-Bold.ttf",
    weight: 700,
    colors: { text: "#ffffff", accent: "#ff5a5f", box: "#ff5a5f" },
    uppercase: false,
    maxLines: 2,
    maxChars: { portrait: 16, landscape: 28, square: 20 },
  },
  karaoke: {
    id: "karaoke",
    name: { en: "Karaoke", tr: "Karaoke" },
    font: "montserrat/Montserrat-Variable.ttf",
    weight: 700,
    colors: { text: "#ffffff", accent: "#7be0ff" },
    uppercase: false,
    maxLines: 2,
    maxChars: { portrait: 16, landscape: 30, square: 22 },
  },
  daktilo: {
    id: "daktilo",
    name: { en: "Typewriter", tr: "Daktilo" },
    font: "ibm-plex-mono/IBMPlexMono-Regular.ttf",
    weight: 400,
    colors: { text: "#f4f1ea", accent: "#f4f1ea", box: "rgba(10,12,16,0.7)" },
    uppercase: false,
    maxLines: 2,
    maxChars: { portrait: 18, landscape: 32, square: 24 },
  },
  sakin: {
    id: "sakin",
    name: { en: "Calm", tr: "Sakin" },
    font: "poppins/Poppins-Regular.ttf",
    weight: 400,
    colors: { text: "#e4e1da", accent: "#e4e1da" },
    uppercase: false,
    lowercase: true,
    maxLines: 1,
    maxChars: { portrait: 24, landscape: 44, square: 32 },
  },
  bant: {
    id: "bant",
    name: { en: "Band", tr: "Bant" },
    font: "inter/Inter-Variable.ttf",
    weight: 600,
    colors: { text: "#ffffff", accent: "#ffffff", box: "rgba(10,12,16,0.62)" },
    uppercase: false,
    maxLines: 2,
    maxChars: { portrait: 20, landscape: 36, square: 26 },
  },
  editoryal: {
    id: "editoryal",
    name: { en: "Editorial", tr: "Editoryal" },
    font: "playfair-display/PlayfairDisplay-Variable.ttf",
    fontActive: "playfair-display/PlayfairDisplay-Italic-Variable.ttf",
    weight: 500,
    colors: { text: "#ffffff", accent: "#e8c58a" },
    uppercase: false,
    maxLines: 2,
    maxChars: { portrait: 18, landscape: 32, square: 22 },
  },
};

/** The nine looks in grid order; the first follows the video style and no look repeats. */
export function captionGrid(videoStyle: string | null): CaptionStyleId[] {
  const kil = videoStyle === "kil-lacivert";
  return [
    kil ? "kil-lacivert" : "bant",
    "loud",
    "dinamik",
    "hap",
    "karaoke",
    "daktilo",
    "sakin",
    kil ? "bant" : "kil-lacivert",
    "editoryal",
  ];
}
