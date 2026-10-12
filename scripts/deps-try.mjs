#!/usr/bin/env node
// Try one dependency update on this Mac: node scripts/deps-try.mjs <id> [version] [--no-bump] [--pr]
// Works in ../kilnframe-deps-<id> (a git worktree from origin/main); never touches this working tree.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { latest } from "./deps/readers.mjs";
import {
  applyBump,
  comparableGoldens,
  compareScene,
  prepareWorktree,
  reportMarkdown,
  worktreeBase,
} from "./deps/try.mjs";
import { loadDeps } from "./deps/versions.mjs";
import { renderGolden } from "./golden-add.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const [id, wanted] = args.filter((a) => !a.startsWith("--"));
const dep = loadDeps(root).find((d) => d.id === id);
if (!dep) {
  console.error(`Unknown dependency "${id}"; the ids are in deps.json.`);
  process.exit(2);
}
const to = wanted ?? (await latest(dep)).latest;
const branch = `deps/${id}-${to}`;
const wt = join(root, "..", `kilnframe-deps-${id}`);
const outDir = join(root, "out", "deps", `${id}-${to}`);
mkdirSync(outDir, { recursive: true });

const run = (cmd, a, cwd = wt) => execFileSync(cmd, a, { cwd, stdio: "inherit" });
const steps = [];
const step = (name, fn) => {
  try {
    fn();
    steps.push({ name, ok: true });
    return true;
  } catch (err) {
    steps.push({ name, ok: false, detail: String(err.message).split("\n")[0] });
    return false;
  }
};

run("git", ["fetch", "origin", "main"], root);
let ok =
  step(`worktree ${wt}`, () =>
    prepareWorktree((cmd, a) => run(cmd, a, root), {
      wt,
      branch,
      base: worktreeBase(),
      exists: existsSync(wt),
    }),
  ) &&
  step(`sürüm ${dep.current} → ${to}`, () => {
    if (flags.has("--no-bump")) return;
    const edited = applyBump(wt, dep, to);
    // the repo's own formatter, so pnpm check does not trip over the rewritten JSON
    run("npx", ["prettier", "--write", ...edited]);
  }) &&
  step("pnpm install", () => run("pnpm", ["install"])) &&
  step("pnpm build", () => run("pnpm", ["build"])) &&
  step("pnpm check", () => run("pnpm", ["check"]));

const scenes = [];
if (ok && dep.group === "render") {
  const goldens = join(wt, "examples", "golden");
  const names = comparableGoldens(goldens);
  // a renderer update compared with nothing must not pass
  ok =
    step("altın sahne var", () => {
      if (!names.length) throw new Error(`no golden scene with reference frames in ${goldens}`);
    }) && ok;
  for (const name of names) {
    const g = JSON.parse(readFileSync(join(goldens, name, "golden.json"), "utf8"));
    ok =
      step(`render ${name}`, () => {
        const r = renderGolden(join(goldens, name), join(outDir, "render", name), wt);
        scenes.push({
          ...compareScene(join(goldens, name), r.video, outDir),
          ms: { old: g.renderMs, new: r.ms },
        });
      }) && ok;
  }
}
let manual;
if (ok && dep.group === "app") {
  step("test kurulumu (stage.mjs)", () => run("node", ["packages/app/scripts/stage.mjs"]));
  manual = "uygulamayı kurup bir animasyon yapın; Electron ve güncelleyici için son kontrol budur";
}

const report = { dep, from: dep.current, to, steps, scenes, manual };
writeFileSync(join(outDir, "report.md"), reportMarkdown(report));
console.log(`report: ${join(outDir, "report.md")}`);

const passed = steps.every((s) => s.ok) && scenes.every((s) => s.pass);
if (passed && flags.has("--pr")) {
  run("git", ["add", "-A"]);
  run("git", ["commit", "-m", `Update ${id} to ${to}`]);
  run("git", ["push", "-u", "origin", branch]);
  run("gh", [
    "pr",
    "create",
    "-R",
    "erhanmeydan/kilnframe",
    "--head",
    branch,
    "--title",
    `Update ${id} to ${to}`,
    "--body-file",
    join(outDir, "report.md"),
  ]);
}
process.exit(passed ? 0 : 1);
