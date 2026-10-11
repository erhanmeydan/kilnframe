// The probe panel from the M4 API checks (docs/premiere-uxp.md), built on its own: pnpm --filter @kilnframe/panel build:probe
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  publicDir: "probe/public",
  base: "./",
  build: {
    outDir: "dist-probe",
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    target: "esnext",
    rolldownOptions: {
      input: resolve(root, "probe/probe.ts"),
      external: ["fs", "os", "premierepro", "uxp"],
      output: { format: "cjs", entryFileNames: "[name].js" },
    },
  },
});
