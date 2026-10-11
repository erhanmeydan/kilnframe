// Runs only the plan stage for every benchmark case (examples/benchmark/cases.json), one model call per
// case, and writes each plan plus a summary to out/benchmark/<run>/. Transcripts are made locally first
// when missing. Needs a build (pnpm build).
// Usage: node scripts/benchmark-plan.mjs [--provider claude-code] [--model claude-opus-5-5] [--base-url <url>] [--style kil-lacivert] [case-id ...]
// API keys come from KILNFRAME_API_KEY / ANTHROPIC_API_KEY.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NoSpeechError,
  TranscriptSchema,
  UsageMeter,
  createTextProvider,
  loadDefaults,
  loadStyle,
  parseFps,
  planInsert,
  transcribe,
} from "../packages/core/dist/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const providerName = opt("provider", "claude-code");
const model = opt("model", undefined);
const styleName = opt("style", "kil-lacivert");
const baseURL = opt("base-url", undefined);
const apiKey = process.env.KILNFRAME_API_KEY;
const only = args;

const defaults = loadDefaults();
const { cases } = JSON.parse(readFileSync(join(root, "examples/benchmark/cases.json"), "utf8"));
const runDir = join(
  root,
  "out",
  "benchmark",
  `plan-${providerName}-${model ?? (baseURL ? new URL(baseURL).hostname : defaults.text.model)}`,
);
mkdirSync(runDir, { recursive: true });
const provider = createTextProvider(defaults, { provider: providerName, model, baseURL, apiKey });
provider.preflight?.();
const style = loadStyle(styleName);

const rows = [];
for (const c of cases) {
  if (only.length && !only.includes(c.id)) continue;
  const audio = join(root, c.file ?? `examples/benchmark/audio/${c.id}.wav`);
  if (!existsSync(audio)) {
    console.log(`${c.id}: audio missing (${audio}), skipped`);
    continue;
  }
  const trPath = join(root, "out", "benchmark", `${c.id}.transcript.json`);
  let transcript;
  try {
    transcript = existsSync(trPath)
      ? TranscriptSchema.parse(JSON.parse(readFileSync(trPath, "utf8")))
      : await transcribe({ audioPath: audio, defaults, language: c.language });
    writeFileSync(trPath, JSON.stringify(transcript, null, 2));
  } catch (err) {
    const outcome = err instanceof NoSpeechError ? "no-speech" : `error: ${err.message}`;
    console.log(`${c.id}: ${outcome}`);
    rows.push({ id: c.id, outcome, expect: c.expect });
    continue;
  }
  const usage = new UsageMeter();
  const started = Date.now();
  try {
    const plan = await planInsert({
      provider: usage.wrap(provider),
      transcript,
      style,
      job: {
        style: styleName,
        mode: "fullscreen",
        format: "landscape",
        width: 1920,
        height: 1080,
        fps: parseFps("30000/1001"),
        handlesFrames: 19,
      },
    });
    writeFileSync(join(runDir, `${c.id}.plan.json`), JSON.stringify(plan, null, 2));
    const total = usage.total();
    const row = {
      id: c.id,
      outcome: "ok",
      seconds: Math.round((Date.now() - started) / 100) / 10,
      calls: usage.calls.length,
      listPriceUsd: total.listPriceUsd ?? null,
      durationS: Math.round(transcript.duration_s * 10) / 10,
      scenes: plan.scenes.map((s) => ({
        id: s.id,
        technique: s.technique,
        text: s.on_screen_text,
        seconds: Math.round(((s.end_frame - s.start_frame) * 1001) / 3000) / 10,
      })),
      expect: c.expect,
    };
    rows.push(row);
    console.log(
      `${c.id}: ${row.scenes.length} scenes, ${row.scenes.map((s) => s.technique).join(" ")}, ${row.seconds} s, ${row.calls} call(s)`,
    );
  } catch (err) {
    rows.push({ id: c.id, outcome: `error: ${err.message}`, expect: c.expect });
    console.log(`${c.id}: error: ${err.message}`);
  }
}
writeFileSync(join(runDir, "summary.json"), JSON.stringify(rows, null, 2));
console.log(join(runDir, "summary.json"));
