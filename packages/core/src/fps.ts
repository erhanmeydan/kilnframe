/** A frame rate kept as an exact rational, e.g. 29.97 is 30000/1001. */
export interface Fps {
  num: number;
  den: number;
}

const FPS_PATTERN = /^(\d+)(?:\/(\d+))?$/;

/** Parses "30000/1001", "25" or "24/1" into an exact rational frame rate. */
export function parseFps(input: string): Fps {
  const match = FPS_PATTERN.exec(input.trim());
  if (!match) throw new Error(`Invalid fps: "${input}". Expected e.g. "25" or "30000/1001".`);
  const num = Number(match[1]);
  const den = match[2] === undefined ? 1 : Number(match[2]);
  if (num <= 0 || den <= 0) throw new Error(`Invalid fps: "${input}". Values must be positive.`);
  return { num, den };
}

export function fpsToNumber(fps: Fps): number {
  return fps.num / fps.den;
}

export function formatFps(fps: Fps): string {
  return fps.den === 1 ? String(fps.num) : `${fps.num}/${fps.den}`;
}

/** Start time of a frame in seconds, computed exactly from the rational rate. */
export function framesToSeconds(frames: number, fps: Fps): number {
  return (frames * fps.den) / fps.num;
}

/** Index of the frame that contains the given time. */
export function secondsToFrame(seconds: number, fps: Fps): number {
  return Math.floor((seconds * fps.num) / fps.den + 1e-9);
}

/** Frame rates HyperFrames renders exactly; others are rounded by it without warning. */
export const STANDARD_RATES: Fps[] = [
  { num: 24000, den: 1001 },
  { num: 24, den: 1 },
  { num: 25, den: 1 },
  { num: 30000, den: 1001 },
  { num: 30, den: 1 },
  { num: 48, den: 1 },
  { num: 50, den: 1 },
  { num: 60000, den: 1001 },
  { num: 60, den: 1 },
];

/**
 * The rate to render at. Premiere reports variable frame rate footage at its own measured rate, for
 * example 254016000000/10587056659 (23.993 fps); HyperFrames would silently round that. Such rates render
 * at the nearest standard rate and the delivery step converts to the exact sequence rate.
 */
export function renderFps(fps: Fps): Fps {
  const value = fpsToNumber(fps);
  const exact = STANDARD_RATES.find((r) => r.num * fps.den === fps.num * r.den);
  if (exact) return exact;
  return STANDARD_RATES.reduce((best, r) =>
    Math.abs(fpsToNumber(r) - value) < Math.abs(fpsToNumber(best) - value) ? r : best,
  );
}
