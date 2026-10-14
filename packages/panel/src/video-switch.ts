/**
 * Another sequence is open: the last video's result, note and images do not belong to it. A running job
 * keeps its screen until it ends; the first read has nothing to forget.
 */
export function isOtherVideo(previous: string | undefined, next: string, busy: boolean): boolean {
  return previous !== undefined && previous !== next && !busy;
}
