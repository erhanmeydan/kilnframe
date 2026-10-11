// Which part of the sequence an insert covers: the in/out
// range when it is set, otherwise the whole sequence; ranges over 45 s are made in parts (core parts.ts).
import { t } from "./i18n";

/** Premiere returns this (in seconds) for an unset in or out point (checked in 26.5.2). */
const UNSET = -1000;
export const LONG_RANGE_SECONDS = 45;

/** Story mode's own length: "45", "1:30", "2 dk", "90 sn", "2 min", "90 s". Seconds, or null when unreadable. */
export function parseLength(text: string): number | null {
  const s = text.trim().toLocaleLowerCase("tr").replace(",", ".");
  let m = /^(\d+):([0-5]?\d)$/.exec(s);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = /^(\d+(?:\.\d+)?)\s*(dk|dakika|min|m)$/.exec(s);
  if (m) return Math.round(Number(m[1]) * 60);
  m = /^(\d+)\s*(sn|saniye|sec|s)?$/.exec(s);
  return m ? Number(m[1]) : null;
}

/** The story length the companion accepts. */
export const STORY_LENGTH = { minS: 10, maxS: 600 };

export interface Range {
  startS: number;
  endS: number;
  durationS: number;
  /** "inout" when the editor marked a range, "sequence" when the whole sequence is used. */
  source: "inout" | "sequence";
  /** Shown above the button; the editor may still go on. */
  warning: string | null;
}

export function pickRange(inS: number, outS: number, sequenceEndS: number): Range {
  const hasInOut = inS > UNSET && outS > UNSET && outS > inS;
  const startS = hasInOut ? Math.max(0, inS) : 0;
  const endS = hasInOut ? Math.min(outS, sequenceEndS || outS) : sequenceEndS;
  const durationS = Math.max(0, endS - startS);
  const warning =
    durationS > LONG_RANGE_SECONDS
      ? t("range.long", { duration: formatDuration(durationS) })
      : null;
  return { startS, endS, durationS, source: hasInOut ? "inout" : "sequence", warning };
}

/** 75.4 -> "1 min 15 s" / "1 dk 15 sn", 9.6 -> "10 s" / "10 sn". */
export function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  if (!m) return t("dur.sec", { s });
  return s % 60 ? t("dur.minSec", { m, s: s % 60 }) : t("dur.min", { m });
}

/** 5.04 -> "00:05". */
export function formatTimecode(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => String(n).padStart(2, "0");
  return s >= 3600
    ? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`
    : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

/** A frame of the footage the panel exported, at a time of the sequence. */
export interface FootageFrame {
  path: string;
  seqS: number;
}

/**
 * When to take frames of the footage for automatic mode (sequence seconds): three spread over a short
 * range, one about every 20 s of a long one (at most 6), each away from the cuts at the ends.
 */
export function footageFrameTimes(range: Pick<Range, "startS" | "durationS">): number[] {
  const n = range.durationS > LONG_RANGE_SECONDS ? Math.min(6, Math.ceil(range.durationS / 20)) : 3;
  const at = n === 3 ? [0.15, 0.5, 0.85] : Array.from({ length: n }, (_, k) => (k + 0.5) / n);
  return at.map((f) => range.startS + f * range.durationS);
}

/**
 * The frames for one job, in seconds from its start: those inside its range (at most three), or the
 * nearest one when none falls inside (a part of a long range), set to the closer edge.
 */
export function framesForRange(
  frames: FootageFrame[],
  startS: number,
  endS: number,
): { path: string; atS: number }[] {
  const inside = frames.filter((f) => f.seqS >= startS && f.seqS <= endS).slice(0, 3);
  const nearest = [...frames].sort(
    (a, b) =>
      Math.min(Math.abs(a.seqS - startS), Math.abs(a.seqS - endS)) -
      Math.min(Math.abs(b.seqS - startS), Math.abs(b.seqS - endS)),
  )[0];
  const chosen = inside.length ? inside : nearest ? [nearest] : [];
  return chosen.map((f) => ({
    path: f.path,
    atS: +Math.min(endS - startS, Math.max(0, f.seqS - startS)).toFixed(3),
  }));
}
