#!/usr/bin/env node
// Weekly dependency check: newest stable version of every pin in deps.json, pnpm audit, one issue.
// Usage: node scripts/deps-check.mjs --print | --issue
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAudit } from "./deps/audit.mjs";
import { issueBody, newItems, sameContent } from "./deps/issue.mjs";
import { Unreachable, latest } from "./deps/readers.mjs";
import { loadDeps } from "./deps/versions.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "erhanmeydan/kilnframe";
const LABEL = "dependencies";
const TITLE = "Bağımlılık güncellemeleri";

const suggested =
  JSON.parse(
    readFileSync(join(root, "packages/core/config/providers.json"), "utf8"),
  ).providers.find((p) => p.id === "openrouter")?.models ?? [];

const results = await Promise.all(
  loadDeps(root).map(async (dep) => {
    try {
      const r = await latest(dep);
      if (dep.source.type === "openrouter-models") r.extra.suggested = suggested;
      return { dep, ...r };
    } catch (err) {
      return {
        dep,
        error: err instanceof Unreachable ? err.message : `beklenmeyen hata: ${err.message}`,
      };
    }
  }),
);
// manual sources are listed in deps.json for the record; they have nothing to check
const checked = results.filter((r) => r.dep.source.type !== "manual");

let audit;
try {
  audit = execFileSync("pnpm", ["audit", "--json"], { cwd: root, encoding: "utf8" });
} catch (err) {
  audit = err.stdout || "{}"; // pnpm audit exits non-zero when it finds advisories
}
const advisories = parseAudit(audit);

const gh = (args) =>
  execFileSync("gh", ["-R", REPO, ...args], { encoding: "utf8", cwd: root }).trim();

if (process.argv.includes("--issue")) {
  const found = JSON.parse(
    gh([
      "issue",
      "list",
      "--label",
      LABEL,
      "--state",
      "open",
      "--json",
      "number,body",
      "--limit",
      "1",
    ]),
  )[0];
  const body = issueBody(checked, advisories, found?.body ?? null, new Date());
  if (!found) {
    gh(["issue", "create", "--title", TITLE, "--label", LABEL, "--body", body]);
    console.log("issue created");
  } else if (!sameContent(found.body, body)) {
    gh(["issue", "edit", String(found.number), "--body", body]);
    // a notification only for a new update or advisory, not for a flaky source or a model list change
    const fresh = newItems(found.body, body);
    if (fresh.length)
      gh(["issue", "comment", String(found.number), "--body", `Yeni: ${fresh.join(", ")}`]);
    console.log(
      `issue #${found.number} updated${fresh.length ? `, new: ${fresh.join(", ")}` : ""}`,
    );
  } else {
    console.log(`issue #${found.number} unchanged`);
  }
} else {
  process.stdout.write(issueBody(checked, advisories, null, new Date()));
}
