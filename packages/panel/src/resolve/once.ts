// The panel's connection to Resolve: made on first use and kept, but made again after a failure (Resolve still
// starting, a project being opened), so one bad moment does not leave the panel broken until it is reopened.

export function untilItWorks<T>(make: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= make().catch((err: unknown) => {
      pending = null;
      throw err;
    });
    return pending;
  };
}
