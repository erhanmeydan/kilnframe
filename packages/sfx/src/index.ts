export { SAMPLE_RATE } from "./constants.js";

/** Converts a decibel value to a linear gain factor. */
export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

/** Converts a linear gain factor to decibels. Returns -Infinity for silence. */
export function gainToDb(gain: number): number {
  return 20 * Math.log10(Math.abs(gain));
}

export * from "./dsp.js";
export * from "./mix.js";
export * from "./palette.js";
export * from "./synths.js";
export * from "./wav.js";
