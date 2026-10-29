import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { framesToSeconds, parseFps } from "../fps.js";
import type { Plan } from "../schemas/plan.js";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

export function vendorDir(): string {
  return process.env.KILNFRAME_VENDOR_DIR ?? join(repoRoot, "vendor");
}

/** HyperFrames attributes are decimal seconds; six decimals keep 30000/1001 frame edges exact enough. */
export function seconds(frames: number, fps: string): string {
  return framesToSeconds(frames, parseFps(fps))
    .toFixed(6)
    .replace(/\.?0+$/, "");
}

/** The root composition: one host per scene, played back to back, plus shared runtime scripts. */
/** GSAP plugins shipped in vendor/gsap, loaded and registered for every scene (same licence as GSAP). */
export const GSAP_PLUGINS = [
  "SplitText",
  "DrawSVGPlugin",
  "MorphSVGPlugin",
  "MotionPathPlugin",
  "CustomEase",
] as const;

export function rootHtml(plan: Plan): string {
  const { width, height, fps } = plan;
  const hosts = plan.scenes
    .map(
      (s) =>
        `      <div id="${s.id}-host" data-composition-id="${s.id}" data-composition-src="compositions/${s.id}.html" data-start="${seconds(s.start_frame, fps)}" data-duration="${seconds(s.end_frame - s.start_frame, fps)}" data-track-index="0" data-width="${width}" data-height="${height}"></div>`,
    )
    .join("\n");
  const background = plan.mode === "overlay" ? "transparent" : "#000";
  return `<!doctype html>
<html lang="tr">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${width}, height=${height}" />
    <title>${escapeHtml(plan.topic)}</title>
    <script src="vendor/gsap/gsap.min.js"></script>
${GSAP_PLUGINS.map((p) => `    <script src="vendor/gsap/${p}.min.js"></script>`).join("\n")}
    <script>gsap.registerPlugin(${GSAP_PLUGINS.join(", ")});</script>
    <script src="vendor/d3/d3.min.js"></script>
    <script src="vendor/icons/lucide.js"></script>
    <script type="importmap">
      { "imports": { "three": "./vendor/three/three.module.js", "three/addons/": "./vendor/three/addons/" } }
    </script>
    <style>
      html, body { margin: 0; background: ${background}; }
      #root { position: relative; width: 100%; height: 100%; overflow: hidden; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-width="${width}" data-height="${height}" data-duration="${seconds(plan.duration_frames, fps)}">
${hosts}
    </div>
    <script>
      window.__timelines["main"] = gsap.timeline({ paused: true });
    </script>
  </body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );
}

export interface AssembleOptions {
  plan: Plan;
  /** Scene sub-composition HTML keyed by scene id. */
  scenes: Record<string, string>;
  projectDir: string;
  /** Folder with the editor's images (<job>/assets); required when the plan lists any. */
  assetsDir?: string | undefined;
}

/** Writes a renderable HyperFrames project: index.html, compositions/<id>.html, vendor/. */
export function assembleProject({ plan, scenes, projectDir, assetsDir }: AssembleOptions): void {
  for (const s of plan.scenes) {
    if (!scenes[s.id]) throw new Error(`No composition for scene ${s.id}.`);
  }
  mkdirSync(join(projectDir, "compositions"), { recursive: true });
  writeFileSync(join(projectDir, "index.html"), rootHtml(plan));
  for (const s of plan.scenes)
    writeFileSync(join(projectDir, "compositions", `${s.id}.html`), scenes[s.id] as string);
  writeFileSync(join(projectDir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  cpSync(vendorDir(), join(projectDir, "vendor"), { recursive: true });
  if (plan.assets.length) {
    if (!assetsDir || !existsSync(assetsDir))
      throw new Error("The plan uses the editor's images, but their folder is missing.");
    cpSync(assetsDir, join(projectDir, "assets"), { recursive: true });
  }
}
