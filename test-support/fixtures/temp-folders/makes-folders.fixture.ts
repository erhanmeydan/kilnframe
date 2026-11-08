// A test file that makes scratch folders in the temporary folder in every way the tests do (at its start, in a
// test, waited on and called back) and removes none of them; it writes where they are for the test that runs it.
import { mkdtemp, mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp as mkdtempAsync } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";

const prefix = join(tmpdir(), process.env.KF_TEMP_PREFIX ?? "kf-sweep-");
const made = [mkdtempSync(prefix)];

test("makes folders and leaves them", async () => {
  const inner = mkdtempSync(prefix);
  writeFileSync(join(inner, "f.txt"), "x");
  made.push(inner, await mkdtempAsync(prefix));
  made.push(
    await new Promise<string>((res, rej) =>
      mkdtemp(prefix, (err, dir) => (err ? rej(err) : res(dir))),
    ),
  );
  expect(made).toHaveLength(4);
});

afterAll(() => writeFileSync(process.env.KF_TEMP_REPORT as string, JSON.stringify(made)));
