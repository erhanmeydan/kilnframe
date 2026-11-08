import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

// Tests never see the editor's own styles in ~/.kilnframe/styles; they get an empty folder.
const userStyles = mkdtempSync(join(tmpdir(), "mi-user-styles-"));
// the config is loaded in every run, by the workers too; each removes the folder it made when it ends
const removeUserStyles = () => rmSync(userStyles, { recursive: true, force: true });
process.on("exit", removeUserStyles);
// a run stopped with Ctrl-C or a kill does not reach "exit" alone: remove it then too, and let the signal go on
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    removeUserStyles();
    if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
  });
}

export default defineConfig({
  test: {
    // out/ holds build copies of the packages (packages/app/scripts/stage.mjs), with their tests
    exclude: [...configDefaults.exclude, "out/**"],
    // every test file's scratch folders in the temporary folder go when the file has run
    setupFiles: ["./test-support/temp-folders.ts"],
    env: { KILNFRAME_USER_STYLES_DIR: userStyles },
  },
});
