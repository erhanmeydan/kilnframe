// Builds vendor/icons/lucide.js from the lucide-static package: every icon's SVG nodes and search tags, and
// the kfIcon() helper scenes call. Run again to update the icons: node scripts/build-icons.mjs <lucide-static dir>
// (an unpacked `npm pack lucide-static`). The licence is copied next to it.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const src = process.argv[2];
if (!src) {
  console.error("Usage: node scripts/build-icons.mjs <unpacked lucide-static package dir>");
  process.exit(1);
}
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "vendor", "icons");
mkdirSync(out, { recursive: true });
const { version } = JSON.parse(readFileSync(join(src, "package.json"), "utf8"));
const nodes = JSON.parse(readFileSync(join(src, "icon-nodes.json"), "utf8"));
const tags = JSON.parse(readFileSync(join(src, "tags.json"), "utf8"));
const kept = Object.fromEntries(
  Object.keys(tags)
    .filter((n) => nodes[n])
    .map((n) => [n, tags[n]]),
);

const helper = `
/**
 * kfIcon(names, options): a Lucide icon as an <svg> element, ready to place and animate. names is one name
 * or a list tried in order ("film", ["clapperboard", "film", "video"]); when none is an icon name, the first
 * whose words match an icon's tags is used, then a plain circle (with a console warning). The icon is drawn
 * with strokes in currentColor, so CSS color, stroke-width and DrawSVG work on its parts.
 * options: { size (px, default 96), color, strokeWidth (in the icon's 24 unit grid, default 2), className, id }
 */
function kfIcon(names, options = {}) {
  const list = (Array.isArray(names) ? names : [names]).map((n) => String(n).toLowerCase().trim());
  let name = list.find((n) => KF_ICON_NODES[n]);
  if (!name) {
    for (const n of list) {
      const words = n.split(/[\\s-]+/);
      name = Object.keys(KF_ICON_TAGS).find((k) => words.every((w) => k.includes(w) || KF_ICON_TAGS[k].some((t) => t.includes(w))));
      if (name) break;
    }
  }
  if (!name) {
    console.warn("kfIcon: no icon for " + list.join(", "));
    name = "circle";
  }
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  const size = options.size ?? 96;
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", options.color ?? "currentColor");
  svg.setAttribute("stroke-width", String(options.strokeWidth ?? 2));
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("data-icon", name);
  if (options.className) svg.setAttribute("class", options.className);
  if (options.id) svg.id = options.id;
  for (const [tag, attrs] of KF_ICON_NODES[name]) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    svg.appendChild(el);
  }
  return svg;
}
window.kfIcon = kfIcon;
`;
writeFileSync(
  join(out, "lucide.js"),
  `// Lucide ${version} (https://lucide.dev), ISC licence (LICENSE in this folder). Built by scripts/build-icons.mjs.\n` +
    `const KF_ICON_NODES = ${JSON.stringify(Object.fromEntries(Object.keys(kept).map((n) => [n, nodes[n]])))};\n` +
    `const KF_ICON_TAGS = ${JSON.stringify(kept)};\n${helper}`,
);
copyFileSync(join(src, "LICENSE"), join(out, "LICENSE"));
console.log(`lucide ${version}: ${Object.keys(kept).length} icons -> vendor/icons/lucide.js`);
