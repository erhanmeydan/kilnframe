import { modelsDir } from "./config.js";

/** What of transformers.js's `env` the models folder is set on. */
export interface ModelEnv {
  cacheDir: string | null;
  localModelPath: string;
  allowLocalModels: boolean;
  allowRemoteModels: boolean;
}

/** A model file transformers.js did not find on disk while it was kept from the network. */
function missingOnDisk(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "ModelFileNotFoundError" || /not found locally/i.test(err.message))
  );
}

// loads take turns: the network switch is transformers.js's own, shared by every load in the process
let turn: Promise<unknown> = Promise.resolve();
// whether the load holding the turn is fetching its model, and the loads waiting to be told so
let downloading = false;
const waiting = new Set<() => void>();

/** What a load waiting behind another one's first download is told. */
export const WAITING_FOR_DOWNLOAD = "Waiting for another model to finish downloading";

export interface LoadFromDiskOptions {
  /**
   * The stop of the job the load is for: a load stopped while it waits never starts, and one stopped before its
   * model is fetched never fetches it. Stopped while it waits, it answers at once.
   */
  signal?: AbortSignal | undefined;
  /** Told when the load waits behind another load's first download (WAITING_FOR_DOWNLOAD), so it never sits silent. */
  onWait?: ((message: string) => void) | undefined;
}

/**
 * Loads a transformers.js model from the models folder (`<models>/<id>/<file>`) without touching the network once its
 * files are there. Left to itself, transformers.js asks huggingface.co about optional files it does not find (a
 * picture model's tokenizer_config.json, asked by the pipeline whatever `local_files_only` says), and with no network
 * that question is fatal although every file the model needs is on disk; a load given a progress callback also asks
 * it each file's size. So the load runs with remote models off. Only when a file the model needs is missing (a model
 * never fetched) is it loaded again with the network on: that is the user's own job or download (a transcription,
 * Remove Pauses, Find Person, a face search) fetching its model the first time, as it always did.
 *
 * Loads take turns, the switch being one for the process. A load whose job is stopped (`signal`) while it waits
 * never runs, and one stopped before its retry never fetches. A load waiting behind a first download is told so
 * (`onWait`).
 */
export function loadFromDisk<T>(
  env: ModelEnv,
  load: () => Promise<T>,
  o: LoadFromDiskOptions = {},
): Promise<T> {
  const { signal, onWait } = o;
  if (signal?.aborted) return Promise.reject(signal.reason);
  const tell = () => onWait?.(WAITING_FOR_DOWNLOAD);
  const run = async (): Promise<T> => {
    waiting.delete(tell);
    signal?.throwIfAborted();
    const dir = modelsDir();
    const remote = env.allowRemoteModels;
    env.cacheDir = dir;
    env.localModelPath = dir;
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    try {
      return await load();
    } catch (err) {
      if (!missingOnDisk(err)) throw err;
      // a stopped job fetches nothing
      signal?.throwIfAborted();
      env.allowRemoteModels = true;
      downloading = true;
      for (const waiter of waiting) waiter();
      return await load();
    } finally {
      downloading = false;
      // as it was for loads made elsewhere
      env.allowRemoteModels = remote;
    }
  };
  if (onWait) {
    waiting.add(tell);
    if (downloading) tell();
  }
  const job = turn.then(run);
  turn = job.catch(() => undefined);
  if (!signal) return job;
  // stopped while it waits: answered now; when its turn comes it does nothing
  return new Promise<T>((resolve, reject) => {
    const stop = () => {
      waiting.delete(tell);
      reject(signal.reason);
    };
    signal.addEventListener("abort", stop, { once: true });
    job.then(
      (value) => {
        signal.removeEventListener("abort", stop);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", stop);
        reject(err);
      },
    );
  });
}
