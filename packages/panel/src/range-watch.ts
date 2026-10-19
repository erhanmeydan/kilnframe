import { pickRange, type Range } from "./range";

/** What the quick look at the sequence gives: its id, in and out points and length, nothing else. */
export interface QuickRange {
  id: string;
  inSeconds: number;
  outSeconds: number;
  endSeconds: number;
}

/**
 * Premiere tells a panel nothing when the in or out point moves, so the panel looks often. Asking for the
 * points alone is quick; the whole sequence (name, rate, size, tracks) is read again only for another one.
 */
export function rangeWatch(
  seq: { guid: string; range: Range; endS: number } | null,
  quick: QuickRange,
): { kind: "same" } | { kind: "full" } | { kind: "range"; range: Range; endS: number } {
  if (!seq || seq.guid !== quick.id) return { kind: "full" };
  const range = pickRange(quick.inSeconds, quick.outSeconds, quick.endSeconds);
  if (
    range.startS === seq.range.startS &&
    range.endS === seq.range.endS &&
    quick.endSeconds === seq.endS
  )
    return { kind: "same" };
  return { kind: "range", range, endS: quick.endSeconds };
}

/**
 * A read of the editor that must answer within `ms`: a Premiere or Resolve busy with a modal dialog or a long
 * task may never answer, and the panel would stop looking at the range until it is reopened.
 */
export function within<T>(read: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The editor did not answer.")), ms);
    read.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
