import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The panel packaged with the app (Resources/plugin/), written by scripts/stage.mjs. */
export interface BundledPlugin {
  file: string;
  id: string;
  name: string;
  version: string;
  /** SHA-256 of the .ccx: a rebuilt panel with the same version is still a different panel. */
  hash: string;
}

export function bundledPlugin(resources = process.resourcesPath ?? ""): BundledPlugin | null {
  const info = join(resources, "plugin", "plugin.json");
  if (!resources || !existsSync(info)) return null; // development: the panel comes from UDT
  const p = JSON.parse(readFileSync(info, "utf8")) as Omit<BundledPlugin, "file" | "hash"> & {
    file: string;
  };
  const file = join(resources, "plugin", p.file);
  return { ...p, file, hash: createHash("sha256").update(readFileSync(file)).digest("hex") };
}

/**
 * Adobe's Unified Plugin Installer Agent, which Creative Cloud installs with every Adobe app. It installs a
 * .ccx for the signed-in user exactly as the Marketplace would, so Premiere lists and updates the panel.
 */
export function installerAgent(platform = process.platform): string | null {
  const path =
    platform === "darwin"
      ? "/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent"
      : platform === "win32"
        ? "C:\\Program Files\\Common Files\\Adobe\\Adobe Desktop Common\\RemoteComponents\\UPI\\UnifiedPluginInstallerAgent\\UnifiedPluginInstallerAgent.exe"
        : null;
  return path && existsSync(path) ? path : null;
}

/** True when the installed plugin is not the bundled one: never installed, another version or another build. */
export function needsInstall(
  plugin: Pick<BundledPlugin, "id" | "version" | "hash">,
  installed: { id: string; version: string; hash?: string } | undefined,
): boolean {
  return (
    installed?.id !== plugin.id ||
    installed.version !== plugin.version ||
    installed.hash !== plugin.hash
  );
}

/** The agent's arguments: `--install` on macOS, `/install` on Windows (Adobe's UPIA command-line help). */
export function installArgs(file: string, platform = process.platform): string[] {
  return [platform === "win32" ? "/install" : "--install", file];
}

/** Installs the bundled .ccx with Adobe's agent; resolves with what the agent printed. */
export function installPlugin(plugin: BundledPlugin, agent: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(agent, installArgs(plugin.file), { timeout: 120_000 }, (err, stdout, stderr) => {
      const out = `${stdout}${stderr}`.trim();
      if (err || !/Installation Successful/i.test(out))
        reject(new Error(out || err?.message || "the installer gave no answer"));
      else resolve(out);
    });
  });
}
