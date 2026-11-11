// The panel beside FilmCraft (dist-filmcraft/): panel.js, a CommonJS library the Kilnframe app loads into its own
// main process (openFilmCraftPanel), and preload.js. The page, its font, icons and manifest are the Resolve
// build's, copied from dist-resolve/ (vite.resolve.config.mjs runs first). Electron and Node built-ins stay outside.
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const out = resolve(root, "dist-filmcraft");
const page = resolve(root, "dist-resolve");

export default defineConfig({
  publicDir: false,
  build: {
    outDir: out,
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    target: "node22",
    ssr: true,
    rolldownOptions: {
      input: {
        panel: resolve(root, "src/filmcraft/panel.ts"),
        preload: resolve(root, "src/resolve/preload.ts"),
      },
      external: [/^electron$/, /^node:/],
      output: { format: "cjs", entryFileNames: "[name].js" },
    },
  },
  plugins: [
    {
      name: "kilnframe-filmcraft-files",
      closeBundle() {
        mkdirSync(out, { recursive: true });
        for (const f of ["index.html", "index.js", "index.js.map", "manifest.xml"])
          cpSync(resolve(page, f), resolve(out, f));
        for (const d of ["fonts", "icons"])
          cpSync(resolve(page, d), resolve(out, d), { recursive: true });
        // CommonJS also where a package.json above says "module" (this package, when the app runs from the repository)
        writeFileSync(resolve(out, "package.json"), '{ "type": "commonjs" }\n');
      },
    },
  ],
});
