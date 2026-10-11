export interface Rational {
  num: number;
  den: number;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x;
}

/**
 * Exact frame rate from Premiere ticks: ticks per second divided by ticks per frame, reduced.
 * 254016000000 / 8475667200 = 30000/1001. Never round FrameRate.value (docs/premiere-uxp.md).
 */
export function rationalFps(ticksPerSecond: number, ticksPerFrame: number): Rational {
  if (!(ticksPerFrame > 0)) throw new Error(`Invalid ticks per frame: ${ticksPerFrame}`);
  const g = gcd(ticksPerSecond, ticksPerFrame);
  return { num: ticksPerSecond / g, den: ticksPerFrame / g };
}

export function formatRational(r: Rational): string {
  return r.den === 1 ? String(r.num) : `${r.num}/${r.den}`;
}
