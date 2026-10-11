// Generates the synthetic benchmark clips listed in examples/benchmark/cases.json with the macOS voices
// (`say`), as 48 kHz mono WAV files in examples/benchmark/audio/ (gitignored, regenerate any time).
// Usage: node scripts/make-benchmark-audio.mjs [case-id ...]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "examples", "benchmark", "audio");
const ffmpeg = process.env.KILNFRAME_FFMPEG ?? "ffmpeg";
const { cases } = JSON.parse(
  readFileSync(join(root, "examples", "benchmark", "cases.json"), "utf8"),
);
const only = process.argv.slice(2);

if (process.platform !== "darwin") {
  console.error("The synthetic clips use the macOS voices; run this on a Mac.");
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${(r.stderr || r.stdout).slice(0, 400)}`);
}

// A quiet music bed built only from sine tones and pink noise, so it carries no license.
const BED =
  "sine=f=110:d=600,volume=0.10[a];sine=f=164.8:d=600,volume=0.07[b];sine=f=220:d=600,volume=0.05[c];" +
  "anoisesrc=c=pink:a=0.035:d=600[n];[a][b][c][n]amix=inputs=4:normalize=0,tremolo=f=2:d=0.4";

for (const c of cases) {
  if (c.source !== "synthetic" || (only.length && !only.includes(c.id))) continue;
  const wav = join(outDir, `${c.id}.wav`);
  if (c.mix === "music-only") {
    run(ffmpeg, [
      "-v",
      "error",
      "-y",
      "-filter_complex",
      `${BED},atrim=0:${c.durationS ?? 8}`,
      "-ar",
      "48000",
      "-ac",
      "1",
      wav,
    ]);
  } else {
    const aiff = join(outDir, `${c.id}.aiff`);
    run("say", ["-v", c.voice, "-o", aiff, c.text]);
    if (c.mix === "music-bed") {
      run(ffmpeg, [
        "-v",
        "error",
        "-y",
        "-i",
        aiff,
        "-filter_complex",
        `${BED}[bed];[0:a]aresample=48000,volume=1.0[v];[v][bed]amix=inputs=2:duration=first:normalize=0`,
        "-ar",
        "48000",
        "-ac",
        "1",
        wav,
      ]);
    } else {
      run(ffmpeg, ["-v", "error", "-y", "-i", aiff, "-ar", "48000", "-ac", "1", wav]);
    }
    if (existsSync(aiff)) rmSync(aiff);
  }
  const probe = spawnSync(ffmpeg, ["-i", wav], { encoding: "utf8" });
  const dur = /Duration: ([0-9:.]+)/.exec(probe.stderr)?.[1] ?? "?";
  console.log(`${c.id.padEnd(14)} ${dur}  ${wav}`);
}
