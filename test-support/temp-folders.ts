// Every test file's scratch folders in the temporary folder, removed once the file has run. The tests make them with
// mkdtemp (join(tmpdir(), "kf-…")) and few took them away: a developer's temporary folder held hundreds of thousands.
// The three ways to make one are wrapped here, for every test file (vitest's setupFiles), so a test needs nothing of
// its own; only the folders made while the file ran are removed, never one that was there before.

import type * as NodeFs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { afterAll } from "vitest";

const fs = createRequire(import.meta.url)("node:fs") as typeof NodeFs;
const { mkdtempSync, mkdtemp } = fs;
const mkdtempAsync = fs.promises.mkdtemp;
const rmSync = fs.rmSync;

const root = tmpdir();
const roots = new Set([root, fs.realpathSync(root)]);
const made = new Set<string>();

/** A folder of the temporary folder itself is kept to be removed; one inside another test folder goes with it. */
const keep = <T extends string | Buffer>(dir: T): T => {
  const name = String(dir);
  if (roots.has(dirname(name))) made.add(name);
  return dir;
};

fs.mkdtempSync = ((prefix: string, options?: unknown) =>
  keep(mkdtempSync(prefix, options as never))) as typeof fs.mkdtempSync;
fs.mkdtemp = ((prefix: string, ...rest: unknown[]) => {
  const done = rest.pop() as (err: NodeJS.ErrnoException | null, dir: string) => void;
  mkdtemp(prefix, ...(rest as [never]), (err: NodeJS.ErrnoException | null, dir: string) =>
    done(err, err ? dir : keep(dir)),
  );
}) as typeof fs.mkdtemp;
fs.promises.mkdtemp = (async (prefix: string, options?: unknown) =>
  keep(await mkdtempAsync(prefix, options as never))) as typeof fs.promises.mkdtemp;
// the test files import node:fs and node:fs/promises as modules: they see these from now on
syncBuiltinESMExports();

// the file's own afterAll hooks run before this one (vitest runs them last in, first out), so nothing still needs them
const sweep = () => {
  for (const dir of made) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // a folder a child process still writes in, on a slow disk: left, as before
    }
  }
  made.clear();
};
afterAll(sweep);
// a run stopped with Ctrl-C or a kill leaves no afterAll behind: remove them then too, and let the signal go on
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    sweep();
    if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
  });
}
