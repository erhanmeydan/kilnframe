// Build layout follows Adobe's uxp-premiere-pro-samples (Apache 2.0): CommonJS output, host modules external.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

// the panel's version when the host does not say (the browser demo); the installed panel reads its manifest
const manifest = JSON.parse(readFileSync(resolve(root, "public", "manifest.json"), "utf8"));

export default defineConfig({
  define: { __PANEL_VERSION__: JSON.stringify(manifest.version) },
  publicDir: "public",
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    target: "esnext",
    rolldownOptions: {
      input: resolve(root, "index.ts"),
      external: ["fs", "os", "premierepro", "uxp"],
      output: { format: "cjs", entryFileNames: "[name].js" },
    },
  },
});
