// The versions the repo really uses, read from the files that pin them; deps.json must agree.
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const json = (f) => JSON.parse(readFileSync(f, "utf8"));
const exact = (v) => v.replace(/^[\^~]/, "");

/** CHROME_VERSION from the installed HyperFrames: the headless Chrome it downloads and renders with. */
export function hyperframesChrome(root) {
  const req = createRequire(join(root, "packages", "core", "package.json"));
  const dist = join(dirname(req.resolve("hyperframes/package.json")), "dist");
  for (const f of readdirSync(dist).filter((f) => f.endsWith(".js"))) {
    const m = /\bCHROME_VERSION = "([\d.]+)"/.exec(readFileSync(join(dist, f), "utf8"));
    if (m) return m[1];
  }
  throw new Error("CHROME_VERSION not found in hyperframes/dist");
}

/** The version a dependency really has in the repo, or null when no file pins it (fonts, model lists). */
export function pinnedVersion(root, dep) {
  const s = dep.source;
  if (dep.id === "chrome-headless-shell") return hyperframesChrome(root);
  if (s.type === "npm" && s.package === "pnpm")
    return json(join(root, "package.json")).packageManager.split("@")[1];
  if (s.type === "npm" && dep.files[0]?.endsWith("package.json")) {
    const versions = dep.files.map((f) => {
      const p = json(join(root, f));
      return { ...p.dependencies, ...p.devDependencies }[s.package];
    });
    const found = versions.filter(Boolean).map(exact);
    if (new Set(found).size > 1) return `differs: ${found.join(", ")}`;
    return found[0] ?? null;
  }
  if (s.type === "npm" && dep.files.includes("vendor/README.md")) {
    const row = readFileSync(join(root, "vendor/README.md"), "utf8")
      .split("\n")
      .find((l) => l.startsWith(`| \`${dep.id}/\``));
    return /(\d+\.\d+\.\d+)/.exec(row ?? "")?.[1] ?? null;
  }
  const ffmpeg = () => readFileSync(join(root, "packages/app/scripts/ffmpeg.mjs"), "utf8");
  if (dep.id === "ffmpeg-mac") return /macos\/arm64\/(\d+_[\d.]+)/.exec(ffmpeg())?.[1] ?? null;
  if (dep.id === "ffmpeg-win") return /(autobuild-[\d-]+)/.exec(ffmpeg())?.[1] ?? null;
  return null;
}
