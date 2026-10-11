#!/usr/bin/env node
// Golden scenes: finished compositions re-rendered on every dependency trial to catch render changes.
// node scripts/golden-add.mjs <job-dir> <name>   copy a job's plan, scenes and assets into examples/golden/<name>
// node scripts/golden-add.mjs --refs <name>      render it twice, keep the first as reference, measure noise
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { framesAt, pixelDiff } from "./deps/diff.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const golden = (name) => join(root, "examples", "golden", name);

/** Renders a golden scene folder into `out` with the core CLI; returns the insert file and the time it took. */
export function renderGolden(dir, out, cwd = root) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  // renderPlan takes a scene's images from <out>/assets
  if (existsSync(join(dir, "assets")))
    cpSync(join(dir, "assets"), join(out, "assets"), { recursive: true });
  const t0 = Date.now();
  execFileSync(
    "node",
    [
      join(cwd, "packages/core/dist/cli.js"),
      "render",
      "--plan",
      join(dir, "plan.json"),
      "--scenes",
      join(dir, "scenes"),
      "--out",
      out,
    ],
    { stdio: "inherit" },
  );
  const video = ["insert.mov", "insert.mp4"].map((f) => join(out, f)).find(existsSync);
  if (!video) throw new Error(`no insert in ${out}`);
  return { video, ms: Date.now() - t0 };
}

function refs(name) {
  const dir = golden(name);
  const g = JSON.parse(readFileSync(join(dir, "golden.json"), "utf8"));
  const a = renderGolden(dir, join(tmpdir(), `golden-${name}-a`));
  const b = renderGolden(dir, join(tmpdir(), `golden-${name}-b`));
  rmSync(join(dir, "ref"), { recursive: true, force: true });
  const first = framesAt(a.video, g.times, join(dir, "ref"));
  const again = framesAt(b.video, g.times, join(tmpdir(), `golden-${name}-b-frames`));
  const noise = first.map((r, i) => pixelDiff(r, again[i]));
  const worst = {
    mean: Math.max(...noise.map((n) => n.mean)),
    changed: Math.max(...noise.map((n) => n.changed)),
  };
  g.noise = worst;
  g.threshold = {
    mean: Math.max(0.5, worst.mean * 3),
    changed: Math.max(0.002, worst.changed * 3),
  };
  g.renderMs = a.ms;
  writeFileSync(join(dir, "golden.json"), JSON.stringify(g, null, 2) + "\n");
  console.log(`${name}: noise ${JSON.stringify(worst)}, threshold ${JSON.stringify(g.threshold)}`);
}

function add(job, name) {
  const project = existsSync(join(job, "project")) ? join(job, "project") : job;
  const plan = JSON.parse(readFileSync(join(project, "plan.json"), "utf8"));
  const dir = golden(name);
  mkdirSync(dir, { recursive: true });
  cpSync(join(project, "plan.json"), join(dir, "plan.json"));
  cpSync(join(project, "compositions"), join(dir, "scenes"), { recursive: true });
  if (existsSync(join(project, "assets")))
    cpSync(join(project, "assets"), join(dir, "assets"), { recursive: true });
  const [num, den = 1] = plan.fps.split("/").map(Number);
  const fps = num / den;
  // two frames per scene: while it builds and near its end, after the main reveal
  const times = plan.scenes.flatMap((s) => {
    const a = s.start_frame / fps;
    const b = s.end_frame / fps;
    return [a + (b - a) * 0.4, a + (b - a) * 0.85].map((t) => Math.round(t * 100) / 100);
  });
  const modes = [...new Set(plan.scenes.map((s) => s.mode ?? plan.mode ?? "fullscreen"))];
  writeFileSync(
    join(dir, "golden.json"),
    JSON.stringify({ name, style: plan.style, format: plan.format, modes, times }, null, 2) + "\n",
  );
  console.log(`added ${dir}; now run: node scripts/golden-add.mjs --refs ${name}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "--refs") refs(process.argv[3]);
  else add(process.argv[2], process.argv[3]);
}
