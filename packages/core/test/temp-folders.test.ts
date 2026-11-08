import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const repo = join(import.meta.dirname, "..", "..", "..");
// vitest sits in this repository's node_modules, or in the one above it when the repository is a submodule
const vitest = join(
  dirname(createRequire(import.meta.url).resolve("vitest/package.json")),
  "vitest.mjs",
);

test("a test run leaves no scratch folder of its own in the temporary folder", async () => {
  // a name of this run's own, so the count is not thrown by the other test files making and removing theirs
  const prefix = `kf-sweep-${process.pid}-`;
  const count = () => readdirSync(tmpdir()).filter((name) => name.startsWith(prefix)).length;
  const report = join(mkdtempSync(join(tmpdir(), "kf-sweep-report-")), "made.json");
  const before = count();
  // the child is a vitest of its own: none of this run's worker settings
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !k.startsWith("VITEST") && k !== "TEST" && k !== "NODE_ENV",
    ),
  );
  await promisify(execFile)(
    process.execPath,
    [
      vitest,
      "run",
      "--config",
      join(repo, "test-support", "fixtures", "temp-folders", "vitest.config.ts"),
    ],
    { cwd: repo, env: { ...env, KF_TEMP_PREFIX: prefix, KF_TEMP_REPORT: report } },
  );
  const made = JSON.parse(readFileSync(report, "utf8")) as string[];
  expect(made).toHaveLength(4);
  expect(made.filter((dir) => existsSync(dir))).toEqual([]);
  expect(count()).toBe(before);
}, 60_000);
