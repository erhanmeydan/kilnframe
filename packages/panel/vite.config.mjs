// Build layout follows Adobe's uxp-premiere-pro-samples (Apache 2.0): CommonJS output, host modules external.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
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
