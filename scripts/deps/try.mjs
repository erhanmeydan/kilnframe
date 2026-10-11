// One dependency update, tried in its own worktree: bump, check, render the golden scenes old and new, report.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { alphaReport, framesAt, pixelDiff, sideBySide } from "./diff.mjs";

/** Trials branch from the published main, never from whatever is uncommitted here. */
export const worktreeBase = (env = process.env) => env.DEPS_TRY_BASE ?? "origin/main";

const MANUAL = {
  "ffmpeg-riedl":
    "packages/app/scripts/ffmpeg.mjs: write the new build's URLs and SHA-256 (from its info page), then run the trial again with --no-bump",
  "github-release":
    "the file listed in deps.json: write the new release by hand, then run the trial again with --no-bump",
  huggingface:
    "the model is read from 'main'; nothing to bump, update deps.json's current after a test transcription",
  "chrome-for-testing": "Chrome comes with HyperFrames: try a HyperFrames update instead",
  "openrouter-models": "model lists are not bumped; edit providers.json by hand",
  manual: "update the files by hand, then run the trial again with --no-bump",
};

/** Writes `version` into the files that pin `dep` and into deps.json; returns the edited files. */
export function applyBump(dir, dep, version) {
  if (dep.source.type !== "npm")
    throw new Error(`${dep.id} cannot be bumped automatically: ${MANUAL[dep.source.type]}`);
  if (dep.files.includes("vendor/README.md"))
    throw new Error(
      `${dep.id} is a vendored file: copy the new build into ${dep.files[0]} and update vendor/README.md, then run with --no-bump`,
    );
  const edited = [];
  for (const f of dep.files.filter((f) => f.endsWith("package.json"))) {
    const p = JSON.parse(readFileSync(join(dir, f), "utf8"));
    for (const k of ["dependencies", "devDependencies"]) {
      const old = p[k]?.[dep.source.package];
      if (old) p[k][dep.source.package] = `${/^[\^~]/.exec(old)?.[0] ?? ""}${version}`;
    }
    if (dep.source.package === "pnpm") p.packageManager = `pnpm@${version}`;
    writeFileSync(join(dir, f), JSON.stringify(p, null, 2) + "\n");
    edited.push(f);
  }
  const d = JSON.parse(readFileSync(join(dir, "deps.json"), "utf8"));
  d.deps.find((x) => x.id === dep.id).current = version;
  writeFileSync(join(dir, "deps.json"), JSON.stringify(d, null, 2) + "\n");
  edited.push("deps.json");
  return edited;
}

/** Frames of a new render against the golden scene's references; overlay renders also get their alpha checked. */
export function compareScene(goldenDir, video, outDir) {
  const g = JSON.parse(readFileSync(join(goldenDir, "golden.json"), "utf8"));
  const refs = readdirSync(join(goldenDir, "ref"))
    .sort()
    .map((f) => join(goldenDir, "ref", f));
  const now = framesAt(video, g.times, join(outDir, g.name, "new"));
  const frames = g.times.map((t, i) => {
    const d = pixelDiff(refs[i], now[i]);
    const over = d.mean > g.threshold.mean || d.changed > g.threshold.changed;
    let image;
    if (over) {
      image = join(g.name, `f${String(i).padStart(2, "0")}.png`);
      sideBySide(refs[i], now[i], join(outDir, image));
    }
    return { t, ...d, image };
  });
  const alpha =
    g.modes?.includes("overlay") || video.endsWith(".mov") ? alphaReport(video) : undefined;
  const alphaOk = !alpha || (alpha.pixFmt.startsWith("yuva") && alpha.transparentShare > 0.05);
  return { name: g.name, frames, alpha, pass: frames.every((f) => !f.image) && alphaOk };
}

const sec = (ms) => `${(ms / 1000).toFixed(1)} s`;

export function reportMarkdown(r) {
  const ok = r.steps.every((s) => s.ok) && r.scenes.every((s) => s.pass);
  const out = [`# ${r.dep.id} ${r.from} → ${r.to}`, "", "## Adımlar"];
  for (const s of r.steps)
    out.push(`- ${s.ok ? "✓" : "✗"} ${s.name}${s.detail ? `: ${s.detail}` : ""}`);
  if (r.scenes.length) {
    out.push(
      "",
      "## Altın sahneler",
      "",
      "| Sahne | Sonuç | En büyük fark | Süre (eski, yeni) |",
      "|---|---|---|---|",
    );
    for (const s of r.scenes) {
      const worst = Math.max(...s.frames.map((f) => f.changed));
      const alpha = s.alpha && !s.pass && s.frames.every((f) => !f.image) ? " (alfa)" : "";
      out.push(
        `| ${s.name} | ${s.pass ? "aynı" : "farklı"}${alpha} | %${(worst * 100).toFixed(2)} piksel | ${s.ms ? `${sec(s.ms.old)}, ${sec(s.ms.new)}` : ""} |`,
      );
    }
    for (const s of r.scenes)
      for (const f of s.frames.filter((f) => f.image))
        out.push(
          "",
          `![${s.name} ${f.t.toFixed(2)} s](${f.image})`,
          "Solda eski, ortada yeni, sağda fark (4 kat).",
        );
  }
  if (r.manual) out.push("", `Elle denenmesi gereken: ${r.manual}`);
  out.push(
    "",
    ok
      ? "Sonuç: bütün adımlar geçti, PR açılabilir."
      : "Sonuç: PR açılmadı, rapora birlikte bakalım.",
  );
  return out.join("\n") + "\n";
}
