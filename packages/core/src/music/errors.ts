/** A music request that failed; `retryable` when asking again may help. */
export class MusicError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
    /** How long the provider asked to wait (a rate limit), when it said. */
    readonly retryAfterS?: number,
  ) {
    super(message);
  }
}
