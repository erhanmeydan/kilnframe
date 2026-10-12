// The Kilnframe panel for DaVinci Resolve Studio, installed by this app like the Premiere plugin. Resolve loads
// Workflow Integration plugins from one folder at start. The plugin needs Blackmagic's WorkflowIntegration.node,
// which Kilnframe does not ship: it is copied from the user's own Resolve install, again whenever Resolve updates it.
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join, posix, win32 } from "node:path";

export const RESOLVE_PLUGIN_ID = "com.kilnframe.resolve";

export interface ResolvePaths {
  /** The Resolve application; its presence means Resolve is installed. */
  app: string;
  /** Blackmagic's native module from the sample plugin of Resolve's developer files. */
  developerNode: string;
  /** Where Resolve looks for Workflow Integration plugins. */
  pluginsDir: string;
}

export function resolvePaths(
  platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): ResolvePaths | null {
  if (platform === "win32") {
    // Blackmagic's Workflow Integrations README; checked on Resolve 21.1.1 (12 Oct 2026). Everyone may write
    // under Support, so no admin rights are needed. Studio and the free version cannot be told apart here.
    const support = win32.join(
      env.ProgramData ?? env.PROGRAMDATA ?? "C:\\ProgramData",
      "Blackmagic Design",
      "DaVinci Resolve",
      "Support",
    );
    return {
      app: win32.join(
        env.ProgramFiles ?? env.PROGRAMFILES ?? "C:\\Program Files",
        "Blackmagic Design",
        "DaVinci Resolve",
        "Resolve.exe",
      ),
      developerNode: win32.join(
        support,
        "Developer",
        "Workflow Integrations",
        "Examples",
        "SamplePlugin",
        "WorkflowIntegration.node",
      ),
      pluginsDir: win32.join(support, "Workflow Integration Plugins"),
    };
  }
  if (platform !== "darwin") return null;
  // a Mac path is always a POSIX path, also when this runs elsewhere (the tests on Windows)
  const support = "/Library/Application Support/Blackmagic Design/DaVinci Resolve";
  return {
    app: "/Applications/DaVinci Resolve/DaVinci Resolve.app",
    developerNode: posix.join(
      support,
      "Developer",
      "Workflow Integrations",
      "Examples",
      "SamplePlugin",
      "WorkflowIntegration.node",
    ),
    pluginsDir: posix.join(support, "Workflow Integration Plugins"),
  };
}

export type ResolveInstallState =
  "no-resolve" | "not-studio" | "no-developer-files" | "no-bundle" | "install" | "up-to-date";

/** Resolve Studio's bundle id; the free version loads no Workflow Integration plugins. */
const STUDIO_ID = "com.blackmagic-design.DaVinciResolve";

/** The app's bundle id, or null when its Info.plist cannot be read (then nothing is ruled out). */
function bundleId(app: string): string | null {
  try {
    const plist = readFileSync(join(app, "Contents", "Info.plist"), "utf8");
    return /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? null;
  } catch {
    return null;
  }
}

const sameFile = (a: string, b: string): boolean => {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
};

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
  const id = bundleId(paths.app);
  if (id && id !== STUDIO_ID) return "not-studio";
  // without Blackmagic's module the panel cannot start: better none than a broken one in the menu
  if (!exists(paths.developerNode)) return "no-developer-files";
  if (!bundled) return "no-bundle";
  const target = join(paths.pluginsDir, RESOLVE_PLUGIN_ID);
  const installed = versionIn(join(target, "manifest.xml"));
  // a Resolve update brings a new WorkflowIntegration.node; the copy beside the panel must follow it
  return installed === bundled.version &&
    sameFile(paths.developerNode, join(target, "WorkflowIntegration.node"))
    ? "up-to-date"
    : "install";
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
