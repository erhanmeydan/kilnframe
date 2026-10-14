/**
 * Another sequence is open: the last video's result, note and images do not belong to it. A running job
 * keeps its screen until it ends; the first read has nothing to forget.
 */
export function isOtherVideo(previous: string | undefined, next: string, busy: boolean): boolean {
  return previous !== undefined && previous !== next && !busy;
}

/**
 * Whether the panel is in the middle of a job, whatever screen is open: a job sent to the background runs
 * on the home screen, and Resolve switches timelines while it places one.
 */
export function videoBusy(s: {
  screen: string;
  reviewing: boolean;
  following: boolean;
  job: { placed: unknown; error: unknown } | null;
}): boolean {
  return (
    s.screen === "progress" ||
    s.reviewing ||
    s.following ||
    (s.job !== null && !s.job.placed && !s.job.error)
  );
}
