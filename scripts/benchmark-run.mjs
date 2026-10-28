// Runs the whole pipeline up to the review stills for benchmark cases (examples/benchmark/cases.json), with
// scene recipes on or off, and records per job: seconds from planning to the stills, output tokens per
// scene, repair calls, scenes filled from a recipe, and whether the job failed. Writes
// out/benchmark/run-<provider>-<model>-<recipes>/summary.json and summary.md. Needs a build (pnpm build).
// The API key is read from the OS keychain the way the app reads it; KILNFRAME_API_KEY overrides it.
// Usage: node scripts/benchmark-run.mjs --provider openrouter --model deepseek/deepseek-v4.1-flash
//          [--recipes on|off] [--repeat 2] [--style flat-infografik] [case-id ...]
// Without --style, cases alternate between the styles that have recipe dresses.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TranscriptSchema,
  createTextProvider,
  loadDefaults,
  parseFps,
  runPipeline,
  transcribe,
} from "../packages/core/dist/index.js";
import { OsKeyStore } from "../packages/companion/dist/keys.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const providerName = opt("provider", "openrouter");
const model = opt("model", undefined);
const recipes = opt("recipes", "on") !== "off";
const repeat = Number(opt("repeat", "2"));
const fixedStyle = opt("style", undefined);
const only = args;
const STYLES = ["flat-infografik", "beyaz-tahta"];

const defaults = loadDefaults();
const apiKey =
  process.env.KILNFRAME_API_KEY ??
  (await new OsKeyStore().get(providerName === "auto" ? "anthropic" : providerName));
const provider = createTextProvider(defaults, { provider: providerName, model, apiKey });
const { cases } = JSON.parse(readFileSync(join(root, "examples/benchmark/cases.json"), "utf8"));
const runDir = join(
  root,
  "out",
  "benchmark",
  `run-${providerName}-${(model ?? defaults.text.model).replace(/\//g, "_")}-${recipes ? "recipes" : "free"}`,
);
mkdirSync(runDir, { recursive: true });

const picked = cases.filter((c) => (only.length ? only.includes(c.id) : true));
const rows = [];
let n = 0;
for (const c of picked) {
  const style = fixedStyle ?? STYLES[n++ % STYLES.length];
  const audio = join(root, c.file ?? `examples/benchmark/audio/${c.id}.wav`);
  if (!existsSync(audio)) {
    console.log(`${c.id}: audio missing (${audio}), skipped`);
    continue;
  }
  const trPath = join(root, "out", "benchmark", `${c.id}.transcript.json`);
  const transcript = existsSync(trPath)
    ? TranscriptSchema.parse(JSON.parse(readFileSync(trPath, "utf8")))
    : await transcribe({ audioPath: audio, defaults, language: c.language });
  writeFileSync(trPath, JSON.stringify(transcript, null, 2));
  for (let k = 1; k <= repeat; k++) {
    const outDir = join(runDir, `${c.id}-${style}-${k}`);
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    const log = [];
    const started = Date.now();
    const row = { id: c.id, style, run: k, recipes };
    try {
      const r = await runPipeline({
        audioPath: audio,
        outDir,
        job: {
          style,
          mode: "fullscreen",
          format: "landscape",
          width: 1920,
          height: 1080,
          fps: parseFps("30000/1001"),
          handlesFrames: 19,
        },
        provider,
        defaults,
        transcript,
        stillsOnly: true,
        recipes,
        onProgress: (m) => log.push([Date.now() - started, m]),
      });
      row.ok = true;
      row.repairRounds = r.repairRounds;
      row.scenes = r.plan.scenes.length;
      row.recipeScenes = r.plan.scenes.filter((s) => s.recipe).length;
    } catch (err) {
      row.ok = false;
      row.error = String(err instanceof Error ? err.message : err).split("\n")[0];
    }
    row.seconds = Math.round((Date.now() - started) / 100) / 10;
    const at = (re) => log.find(([, m]) => re.test(m))?.[0];
    const composeStart = at(/^Composing \d+ scene/);
    const validated = at(/^Validating/);
    row.composeSeconds =
      composeStart !== undefined && validated !== undefined
        ? Math.round((validated - composeStart) / 100) / 10
        : null;
    row.filledScenes = log.filter(([, m]) => /from recipe/.test(m)).length;
    row.recomposed = log.filter(([, m]) => /without its recipe/.test(m)).length;
    const usagePath = join(outDir, "usage.json");
    if (existsSync(usagePath)) {
      const usage = JSON.parse(readFileSync(usagePath, "utf8"));
      row.costUsd = usage.costUsd ?? usage.listPriceUsd ?? null;
      row.outputTokens = usage.total?.outputTokens ?? null;
      const per = (re) => usage.calls.filter((x) => re.test(x.purpose));
      row.composeTokens = per(/^(compose|fill) s\d+$/).map((x) => [
        x.purpose,
        x.usage.outputTokens,
      ]);
      row.repairCalls = per(/^repair |retry$/).length;
    }
    writeFileSync(
      join(outDir, "progress.log"),
      log.map(([t, m]) => `${(t / 1000).toFixed(1)} ${m}`).join("\n"),
    );
    rows.push(row);
    writeFileSync(join(runDir, "summary.json"), JSON.stringify(rows, null, 2));
    console.log(
      `${c.id} ${style} #${k}: ${row.ok ? "ok" : `FAIL ${row.error}`} ${row.seconds} s (compose ${row.composeSeconds} s), ${row.filledScenes}/${row.scenes ?? "?"} from recipes, ${row.repairCalls ?? "?"} repair call(s), $${row.costUsd?.toFixed?.(3) ?? "?"}`,
    );
  }
}

const ok = rows.filter((r) => r.ok);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const fmt = (v, d = 1) => (v === null || v === undefined ? "-" : v.toFixed(d));
const md = [
  `# ${providerName} ${model ?? defaults.text.model}, recipes ${recipes ? "on" : "off"}`,
  "",
  `Jobs: ${rows.length}, failed: ${rows.length - ok.length} (${fmt((100 * (rows.length - ok.length)) / Math.max(1, rows.length), 0)}%)`,
  `Mean seconds to stills: ${fmt(mean(ok.map((r) => r.seconds)))}, mean compose seconds: ${fmt(mean(ok.map((r) => r.composeSeconds).filter((x) => x !== null)))}`,
  `Mean output tokens per job: ${fmt(mean(rows.map((r) => r.outputTokens).filter((x) => x != null)), 0)}, repair calls per job: ${fmt(mean(rows.map((r) => r.repairCalls).filter((x) => x != null)), 2)}`,
  `Scenes from recipes: ${ok.reduce((a, r) => a + r.filledScenes, 0)} of ${ok.reduce((a, r) => a + (r.scenes ?? 0), 0)}`,
  `Total cost: $${fmt(
    rows.reduce((a, r) => a + (r.costUsd ?? 0), 0),
    3,
  )}`,
  "",
  "| Case | Style | Run | Result | Seconds | Compose s | From recipe | Repair calls | Cost |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ...rows.map(
    (r) =>
      `| ${r.id} | ${r.style} | ${r.run} | ${r.ok ? "ok" : `fail: ${r.error?.slice(0, 60)}`} | ${r.seconds} | ${r.composeSeconds ?? "-"} | ${r.filledScenes}/${r.scenes ?? "-"} | ${r.repairCalls ?? "-"} | ${fmt(r.costUsd, 3)} |`,
  ),
].join("\n");
writeFileSync(join(runDir, "summary.md"), `${md}\n`);
console.log(join(runDir, "summary.md"));
