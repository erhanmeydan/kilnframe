// The range sent to the companion is relative to the audio file it cuts: Premiere exports the whole sequence
// (offset 0, the range stays as it is), Resolve renders just the range (offset = the range's start).

export function audioRangeParams(
  range: { startS: number; endS: number },
  offsetSeconds: number,
): { rangeStartS: number; rangeEndS: number } {
  return { rangeStartS: range.startS - offsetSeconds, rangeEndS: range.endS - offsetSeconds };
}
