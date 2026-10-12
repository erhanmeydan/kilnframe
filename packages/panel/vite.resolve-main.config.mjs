// The Electron side of the DaVinci Resolve panel: main.js (window, IPC, the bridge to Resolve) and preload.js,
// written into dist-resolve/ beside the page. Electron, Node built-ins and WorkflowIntegration.node stay outside.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  publicDir: false,
  build: {
    outDir: resolve(root, "dist-resolve"),
    emptyOutDir: false,
    minify: false,
    sourcemap: true,
    target: "node22",
    ssr: true,
    rolldownOptions: {
      input: {
        main: resolve(root, "src/resolve/main.ts"),
        preload: resolve(root, "src/resolve/preload.ts"),
      },
      external: [/^electron$/, /^node:/, /WorkflowIntegration\.node$/],
      output: { format: "cjs", entryFileNames: "[name].js" },
    },
  },
});
