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

/**
 * Loads a transformers.js model from the models folder (`<models>/<id>/<file>`) without touching the network once its
 * files are there. Left to itself, transformers.js asks huggingface.co about optional files it does not find (a
 * picture model's tokenizer_config.json, asked by the pipeline whatever `local_files_only` says), and with no network
 * that question is fatal although every file the model needs is on disk; a load given a progress callback also asks
 * it each file's size. So the load runs with remote models off. Only when a file the model needs is missing (a model
 * never fetched) is it loaded again with the network on: that is the user's own job or download (a transcription,
 * Remove Pauses, Find Person, a face search) fetching its model the first time, as it always did.
 */
export function loadFromDisk<T>(env: ModelEnv, load: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
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
      env.allowRemoteModels = true;
      return await load();
    } finally {
      // as it was for loads made elsewhere
      env.allowRemoteModels = remote;
    }
  };
  const job = turn.then(run);
  turn = job.catch(() => undefined);
  return job;
}
