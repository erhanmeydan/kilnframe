// The FilmCraft build of the panel (dist-filmcraft/): the Resolve page (dist-resolve/, built first) with its own
// Electron main process, which talks to FilmCraft's control channel instead of Resolve.
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const out = resolve(root, "dist-filmcraft");

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
        main: resolve(root, "src/filmcraft/main.ts"),
        preload: resolve(root, "src/resolve/preload.ts"),
      },
      external: [/^electron$/, /^node:/],
      output: { format: "cjs", entryFileNames: "[name].js" },
    },
  },
  plugins: [
    {
      name: "kilnframe-filmcraft-page",
      closeBundle() {
        mkdirSync(out, { recursive: true });
        const page = resolve(root, "dist-resolve");
        for (const f of ["index.html", "index.js", "manifest.xml", "fonts", "icons"])
          cpSync(resolve(page, f), resolve(out, f), { recursive: true });
        // the folder is the Electron app: CommonJS (the panel package is "type": "module") and its name
        writeFileSync(
          resolve(out, "package.json"),
          JSON.stringify(
            {
              name: "kilnframe-filmcraft",
              productName: "Kilnframe",
              main: "main.js",
              type: "commonjs",
            },
            null,
            2,
          ) + "\n",
        );
      },
    },
  ],
});
