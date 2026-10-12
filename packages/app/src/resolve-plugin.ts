// The Kilnframe panel for DaVinci Resolve Studio, installed by this app like the Premiere plugin. Resolve loads
// Workflow Integration plugins from one folder at start. The plugin needs Blackmagic's WorkflowIntegration.node,
// which Kilnframe does not ship: it is copied from the user's own Resolve install, so it always matches it.
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export const RESOLVE_PLUGIN_ID = "com.kilnframe.resolve";

export interface ResolvePaths {
  /** The Resolve application; its presence means Resolve is installed. */
  app: string;
  /** Blackmagic's native module from the sample plugin of Resolve's developer files. */
  developerNode: string;
  /** Where Resolve looks for Workflow Integration plugins. */
  pluginsDir: string;
}

export function resolvePaths(platform = process.platform): ResolvePaths | null {
  if (platform !== "darwin") return null; // Windows follows with its own paths
  const support = "/Library/Application Support/Blackmagic Design/DaVinci Resolve";
  return {
    app: "/Applications/DaVinci Resolve/DaVinci Resolve.app",
    developerNode: join(
      support,
      "Developer",
      "Workflow Integrations",
      "Examples",
      "SamplePlugin",
      "WorkflowIntegration.node",
    ),
    pluginsDir: join(support, "Workflow Integration Plugins"),
  };
}

export type ResolveInstallState =
  "no-resolve" | "no-developer-files" | "no-bundle" | "install" | "up-to-date";

const versionIn = (manifest: string): string | null => {
  try {
    return /<Version>([^<]+)<\/Version>/.exec(readFileSync(manifest, "utf8"))?.[1] ?? null;
  } catch {
    return null;
  }
};

export function resolveInstallState(
  paths: ResolvePaths,
  bundled: { version: string } | null,
  exists: (p: string) => boolean = existsSync,
): ResolveInstallState {
  if (!exists(paths.app)) return "no-resolve";
  // without Blackmagic's module the panel cannot start: better none than a broken one in the menu
  if (!exists(paths.developerNode)) return "no-developer-files";
  if (!bundled) return "no-bundle";
  const installed = versionIn(join(paths.pluginsDir, RESOLVE_PLUGIN_ID, "manifest.xml"));
  return installed === bundled.version ? "up-to-date" : "install";
}

/** The panel's version as built into the app (Resources/resolve-panel/manifest.xml). */
export function bundledResolvePanel(
  resources = process.resourcesPath ?? "",
): { dir: string; version: string } | null {
  const dir = join(resources, "resolve-panel");
  const version = resources ? versionIn(join(dir, "manifest.xml")) : null;
  return version ? { dir, version } : null;
}

/** Replaces the installed panel with the bundled one and adds the user's WorkflowIntegration.node. */
export function installResolvePanel(bundledDir: string, paths: ResolvePaths): void {
  const target = join(paths.pluginsDir, RESOLVE_PLUGIN_ID);
  try {
    rmSync(target, { recursive: true, force: true });
    cpSync(bundledDir, target, { recursive: true });
    cpSync(paths.developerNode, join(target, "WorkflowIntegration.node"));
  } catch (err) {
    throw new Error(
      `The Resolve panel could not be copied to ${target}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}
