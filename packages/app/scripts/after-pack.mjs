// electron-builder's afterPack hook: the app's files are in place and not signed yet.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { patchApp } from "./pnpm-patches.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));

export default async function afterPack(context) {
  const resources =
    context.electronPlatformName === "darwin"
      ? join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          "Contents",
          "Resources",
        )
      : join(context.appOutDir, "resources");
  patchApp(root, join(resources, "app", "node_modules"));
}
