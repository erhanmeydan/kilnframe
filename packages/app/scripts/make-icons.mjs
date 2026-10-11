// Draws every icon from the SVG sources in assets/: the app icon (icon.png for Windows, the site and GitHub;
// icon.icns for macOS, on Apple's icon grid) and the menu bar template (trayTemplate.png, @2x). It renders
// and the panel's icons (plugin list, panel tab, header mark), with the headless Chrome HyperFrames uses, so it needs no image library. macOS only (iconutil).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const assets = fileURLToPath(new URL("../assets", import.meta.url));
const shells = join(homedir(), ".cache", "puppeteer", "chrome-headless-shell");
const build = readdirSync(shells).sort().at(-1);
if (!build) throw new Error(`No headless Chrome in ${shells}; render once to fetch it.`);
const shellDir = readdirSync(join(shells, build)).find((d) =>
  d.startsWith("chrome-headless-shell"),
);
const chrome = join(shells, build, shellDir, "chrome-headless-shell");
const work = mkdtempSync(join(tmpdir(), "kilnframe-icons-"));

const icon = readFileSync(join(assets, "icon.svg"), "utf8");
// Apple's grid: an 824 px tile centred in 1024 px, with a soft shadow below it
const inner = icon.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
const macIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs><filter id="shadow" x="-10%" y="-10%" width="120%" height="125%">
    <feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#000" flood-opacity=".3"/></filter></defs>
  <g filter="url(#shadow)"><g transform="translate(100 100) scale(${824 / 1024})">${inner}</g></g>
</svg>`;
const tray = readFileSync(join(assets, "trayTemplate.svg"), "utf8");

function render(svg, size, out) {
  const page = join(work, "page.html");
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  writeFileSync(
    page,
    `<html><body style="margin:0;background:transparent"><img src="${src}" width="${size}" height="${size}" style="display:block"></body></html>`,
  );
  execFileSync(
    chrome,
    [
      "--headless",
      "--disable-gpu",
      "--hide-scrollbars",
      "--default-background-color=00000000",
      `--window-size=${size},${size}`,
      `--screenshot=${out}`,
      `file://${page}`,
    ],
    { stdio: "ignore" },
  );
}

render(icon, 1024, join(assets, "icon.png"));
render(tray, 18, join(assets, "trayTemplate.png"));
render(tray, 36, join(assets, "trayTemplate@2x.png"));

// the panel (UXP): the plugin list shows the app icon; the panel tab and Window menu show the mark alone, light
// on Premiere's dark themes and dark on its light ones; the panel header shows the mark in colour
const panelIcons = fileURLToPath(new URL("../../panel/public/icons", import.meta.url));
const mark = (stroke, shelf) =>
  tray.replace(/stroke="#000"/g, `stroke="${stroke}"`).replace(/fill="#000"/g, `fill="${shelf}"`);
for (const scale of [1, 2]) {
  render(icon, 48 * scale, join(panelIcons, `plugin@${scale}x.png`));
  render(mark("#d6d6d6", "#d6d6d6"), 23 * scale, join(panelIcons, `panel-dark@${scale}x.png`));
  render(mark("#323232", "#323232"), 23 * scale, join(panelIcons, `panel-light@${scale}x.png`));
  render(mark("#e6d9c8", "#c9734a"), 18 * scale, join(panelIcons, `mark@${scale}x.png`));
}
rmSync(join(panelIcons, "icon.svg"), { force: true });

const iconset = join(work, "icon.iconset");
mkdirSync(iconset);
for (const s of [16, 32, 128, 256, 512]) {
  render(macIcon, s, join(iconset, `icon_${s}x${s}.png`));
  render(macIcon, s * 2, join(iconset, `icon_${s}x${s}@2x.png`));
}
execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(assets, "icon.icns")]);
rmSync(work, { recursive: true, force: true });
console.log("app, menu bar and panel icons written");
