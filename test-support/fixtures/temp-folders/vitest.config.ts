// The repository's own test setup, run on the one fixture below alone: what the shared temporary-folder helper
// leaves behind after a test file, as a real run of the tests would.
import { fileURLToPath } from "node:url";
import { mergeConfig } from "vitest/config";
import base from "../../../vitest.config.js";

export default mergeConfig(base, {
  test: {
    root: fileURLToPath(new URL("../../../", import.meta.url)),
    include: ["test-support/fixtures/temp-folders/*.fixture.ts"],
  },
});
