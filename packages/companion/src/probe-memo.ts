/**
 * A probe run once and kept while its answer is good: callers that ask at the same time share one run; an
 * error or an answer that is not good (a GPU probe that found software rendering) is asked again next time,
 * so a graphics card that was busy or a driver that woke up later is seen without restarting the app.
 */
export function keepWhen<T>(
  probe: () => Promise<T>,
  good: (result: T) => boolean,
): () => Promise<T> {
  let running: Promise<T> | null = null;
  return () => {
    running ??= probe().then(
      (result) => {
        if (!good(result)) running = null;
        return result;
      },
      (err: unknown) => {
        running = null;
        throw err;
      },
    );
    return running;
  };
}
