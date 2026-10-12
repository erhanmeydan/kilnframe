// Resolve gives frame rates as strings ("29.97 DF") and timelines start at a timecode (01:00:00:00 by default);
// the scripting API wants absolute frame numbers for renders and placement, timecodes for the playhead.

export interface Rate {
  fps: number;
  nominal: number;
  dropFrame: boolean;
}

const NTSC: Record<string, number> = {
  "23.976": 24,
  "29.97": 30,
  "47.952": 48,
  "59.94": 60,
  "119.88": 120,
};

export function parseRate(s: string): Rate {
  const dropFrame = /\bDF\b/i.test(s);
  const n = s.replace(/\s*DF\s*/i, "").trim();
  const ntsc = NTSC[n];
  const nominal = ntsc ?? Math.round(Number(n));
  const fps = ntsc ? (nominal * 1000) / 1001 : nominal;
  return { fps, nominal, dropFrame };
}

/** The panel's fps string: "30000/1001" for NTSC rates, else the integer. */
export function rateString(r: Rate): string {
  return Number.isInteger(r.fps) ? String(r.fps) : `${r.nominal * 1000}/1001`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Drop frame skips 2 (30 fps) or 4 (60 fps) frame numbers each minute, except every tenth minute. */
const dropCount = (r: Rate) => Math.round(r.nominal / 15);

export function framesToTimecode(frames: number, r: Rate): string {
  let f = frames;
  if (r.dropFrame) {
    const d = dropCount(r);
    const perTen = r.nominal * 600 - d * 9;
    const perMin = r.nominal * 60 - d;
    const tens = Math.floor(f / perTen);
    const rest = f % perTen;
    f += d * 9 * tens + (rest > d ? d * Math.floor((rest - d) / perMin) : 0);
  }
  const ff = f % r.nominal;
  const s = Math.floor(f / r.nominal);
  const sep = r.dropFrame ? ";" : ":";
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}${sep}${pad(ff)}`;
}

export function timecodeToFrames(tc: string, r: Rate): number {
  const [h = 0, m = 0, s = 0, f = 0] = tc.split(/[:;]/).map(Number);
  let frames = ((h * 60 + m) * 60 + s) * r.nominal + f;
  if (r.dropFrame) {
    const minutes = h * 60 + m;
    frames -= dropCount(r) * (minutes - Math.floor(minutes / 10));
  }
  return frames;
}
