import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

// Tests never see the editor's own styles in ~/.kilnframe/styles; they get an empty folder.
const userStyles = mkdtempSync(join(tmpdir(), "mi-user-styles-"));

export default defineConfig({
  test: {
    // out/ holds build copies of the packages (packages/app/scripts/stage.mjs), with their tests
    exclude: [...configDefaults.exclude, "out/**"],
    env: { KILNFRAME_USER_STYLES_DIR: userStyles },
  },
});
