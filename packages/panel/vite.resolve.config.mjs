// The DaVinci Resolve build of the panel (dist-resolve/): the page as one self-contained script (a sandboxed
// Electron page has no require), plus the plugin's manifest, page and icons. vite.resolve-main.config.mjs adds
// the Electron main process and preload.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(root, "public", "manifest.json"), "utf8"));
const out = resolve(root, "dist-resolve");

export default defineConfig({
  define: { __PANEL_VERSION__: JSON.stringify(manifest.version) },
  publicDir: false,
  base: "./",
  build: {
    outDir: out,
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    target: "esnext",
    rolldownOptions: {
      input: resolve(root, "index-resolve.ts"),
      output: { format: "iife", entryFileNames: "index.js" },
    },
  },
  plugins: [
    {
      name: "kilnframe-resolve-files",
      closeBundle() {
        mkdirSync(out, { recursive: true });
        cpSync(resolve(root, "public", "index.html"), resolve(out, "index.html"));
        cpSync(resolve(root, "public", "icons"), resolve(out, "icons"), { recursive: true });
        const xml = readFileSync(resolve(root, "resolve", "manifest.xml"), "utf8");
        writeFileSync(resolve(out, "manifest.xml"), xml.replace("__VERSION__", manifest.version));
      },
    },
  ],
});
