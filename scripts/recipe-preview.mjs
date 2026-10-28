// Renders one scene recipe in one style from its sample data (recipes/<name>/sample.json), for every format
// and mode it lists, and checks each the way the pipeline does (hyperframes check, haze, empty scene).
// Output: out/recipes/<name>/<style>/<format>-<mode>/ with the insert, its stills and a contact sheet of
// four moments (overlay sheets sit over --footage when given). Needs a build (pnpm build).
// Usage: node scripts/recipe-preview.mjs <recipe> <style> [--formats landscape,portrait,square]
//          [--modes fullscreen,overlay] [--side center] [--footage frame.png] [--stills]
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assembleProject,
  buildRecipeScene,
  checkProject,
  draftToPlan,
  fontFaces,
  loadRecipes,
  loadStyle,
  parseFps,
  renderPlan,
  resolveWords,
  safeArea,
  stillTimes,
} from "../packages/core/dist/index.js";
import { emptySceneFindings } from "../packages/core/dist/empty.js";
import { overlayHazeFindings } from "../packages/core/dist/haze.js";
import { readFileSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};
const stillsOnly = flag("stills");
const side = opt("side", "center");
const footage = opt("footage", undefined);
const [recipeName, styleName] = args;
const recipe = loadRecipes().find((r) => r.name === recipeName);
if (!recipe || !styleName) {
  console.error("Usage: node scripts/recipe-preview.mjs <recipe> <style> [options]");
  process.exit(1);
}
const formats = opt("formats", recipe.formats.join(",")).split(",");
const modes = opt("modes", recipe.modes.join(",")).split(",");
const style = loadStyle(styleName);
const sample = JSON.parse(readFileSync(join(root, "recipes", recipe.name, "sample.json"), "utf8"));
const sizes = { landscape: [1920, 1080], portrait: [1080, 1920], square: [1080, 1080] };
const fps = parseFps("30");

const rows = [];
for (const format of formats) {
  for (const mode of modes) {
    const [width, height] = sizes[format];
    const outDir = join(root, "out", "recipes", recipe.name, styleName, `${format}-${mode}`);
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    const job = { style: styleName, mode, format, width, height, fps, handlesFrames: 0 };
    const plan = draftToPlan(
      {
        topic: sample.topic ?? recipe.name,
        summary: recipe.description,
        scenes: [
          {
            id: "s1",
            start_s: 0,
            end_s: sample.durationS,
            anchor_words: [],
            visual: recipe.description,
            on_screen_text: null,
            camera: "hold",
            technique: recipe.technique,
            transition_out: "cut",
            recipe: recipe.name,
            assets: [],
            sfx: [],
          },
        ],
      },
      job,
      sample.durationS,
    );
    if (mode === "overlay") plan.speaker = { side };
    const words = sample.words.map(([text, at]) => ({ text, at }));
    const html = buildRecipeScene(recipe, styleName, resolveWords(recipe, sample.data, words), {
      sceneId: "s1",
      width,
      height,
      format,
      mode,
      durationS: sample.durationS,
      speakerSide: plan.speaker?.side ?? "center",
      safeArea: safeArea(format, width, height),
      fontFaces: fontFaces(style.fonts),
    });
    const projectDir = join(outDir, "project");
    assembleProject({ plan, scenes: { s1: html }, projectDir, assetsDir: join(outDir, "assets") });
    const check = await checkProject(projectDir);
    writeFileSync(join(outDir, "check.json"), `${JSON.stringify(check.raw, null, 2)}\n`);
    const times = stillTimes(plan, []);
    const haze = await overlayHazeFindings(plan, projectDir, times, join(outDir, "haze"));
    const empty = await emptySceneFindings(plan, projectDir, times, join(outDir, "empty"));
    const problems = [...check.errors, ...haze, ...empty].map(
      (f) => `${f.code ?? "check"}: ${f.message}`,
    );
    let ms = null;
    let output = null;
    if (!problems.length) {
      const t0 = Date.now();
      const r = await renderPlan({
        plan,
        scenes: { s1: html },
        outDir,
        stillsOnly,
        prechecked: true,
      });
      ms = Date.now() - t0;
      output = r.output;
      if (output)
        contactSheet(
          output,
          outDir,
          sample.durationS,
          mode === "overlay" ? footage : undefined,
          width,
          height,
        );
    }
    rows.push({
      format,
      mode,
      ok: !problems.length,
      renderS: ms && +(ms / 1000).toFixed(1),
      problems,
    });
    console.log(
      `${format}-${mode}: ${problems.length ? `FAIL\n  ${problems.join("\n  ")}` : `ok${ms ? ` ${(ms / 1000).toFixed(1)} s` : ""}`}`,
    );
  }
}
writeFileSync(
  join(root, "out", "recipes", recipe.name, styleName, "summary.json"),
  `${JSON.stringify(rows, null, 2)}\n`,
);

/** Four moments of the insert side by side (over the footage frame for an overlay). */
function contactSheet(video, outDir, durationS, under, width, height) {
  const at = [0.3, 0.55, 0.8, 0.97].map((f) => (f * durationS).toFixed(2));
  const shots = at.map((t, i) => {
    const file = join(outDir, `moment-${i + 1}.png`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", t, "-i", video, "-frames:v", "1", file]);
    if (!under) return file;
    const over = join(outDir, `moment-${i + 1}-footage.png`);
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-i",
      under,
      "-i",
      file,
      "-filter_complex",
      `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}[bg];[bg][1:v]overlay=format=auto`,
      "-frames:v",
      "1",
      over,
    ]);
    return over;
  });
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    ...shots.flatMap((f) => ["-i", f]),
    "-filter_complex",
    `${shots.map((_, i) => `[${i}:v]scale=-2:540[v${i}]`).join(";")};${shots.map((_, i) => `[v${i}]`).join("")}hstack=inputs=${shots.length}`,
    "-frames:v",
    "1",
    join(outDir, "sheet.png"),
  ]);
}
