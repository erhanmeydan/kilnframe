import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  installResolvePanel,
  resolveInstallState,
  resolvePaths,
  type ResolvePaths,
} from "../src/resolve-plugin";

/** A fake machine: an app folder, Resolve's developer files and its plugin folder, all under a temp dir. */
function machine(
  o: { resolve?: boolean; developer?: boolean; installed?: string; bundleId?: string } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "kf-resolve-"));
  const paths: ResolvePaths = {
    app: join(root, "Applications", "DaVinci Resolve", "DaVinci Resolve.app"),
    developerNode: join(root, "Developer", "SamplePlugin", "WorkflowIntegration.node"),
    pluginsDir: join(root, "Workflow Integration Plugins"),
  };
  if (o.resolve !== false) {
    mkdirSync(join(paths.app, "Contents"), { recursive: true });
    writeFileSync(
      join(paths.app, "Contents", "Info.plist"),
      `<plist><dict>\n\t<key>CFBundleIdentifier</key>\n\t<string>${o.bundleId ?? "com.blackmagic-design.DaVinciResolve"}</string>\n</dict></plist>`,
    );
  }
  if (o.developer !== false) {
    mkdirSync(join(paths.developerNode, ".."), { recursive: true });
    writeFileSync(paths.developerNode, "native module");
  }
  const target = join(paths.pluginsDir, "com.kilnframe.resolve");
  if (o.installed) {
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "manifest.xml"), `<Version>${o.installed}</Version>`);
    writeFileSync(join(target, "stale.js"), "old");
    writeFileSync(join(target, "WorkflowIntegration.node"), "native module");
  }
  const bundled = join(root, "bundle");
  mkdirSync(bundled, { recursive: true });
  for (const f of ["main.js", "preload.js", "index.html", "index.js"])
    writeFileSync(join(bundled, f), f);
  writeFileSync(join(bundled, "manifest.xml"), "<Version>0.2.0</Version>");
  return { paths, target, bundled };
}

describe("resolve plugin", () => {
  it("knows where Resolve keeps things on macOS", () => {
    const p = resolvePaths("darwin");
    expect(p?.pluginsDir).toBe(
      "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins",
    );
    expect(p?.developerNode).toMatch(/Examples\/SamplePlugin\/WorkflowIntegration\.node$/);
  });

  it("does nothing without Resolve", () => {
    const m = machine({ resolve: false });
    expect(resolveInstallState(m.paths, { version: "0.2.0" })).toBe("no-resolve");
  });

  it("does not install a panel that cannot start: no developer files", () => {
    const m = machine({ developer: false });
    expect(resolveInstallState(m.paths, { version: "0.2.0" })).toBe("no-developer-files");
  });

  it("leaves the free DaVinci Resolve alone: Workflow Integrations need Studio", () => {
    const m = machine({ bundleId: "com.blackmagic-design.DaVinciResolveLite" });
    expect(resolveInstallState(m.paths, { version: "0.2.0" })).toBe("not-studio");
  });

  it("installs again when Resolve was updated and its WorkflowIntegration.node changed", () => {
    const m = machine({ installed: "0.2.0" });
    writeFileSync(m.paths.developerNode, "native module of a newer Resolve");
    expect(resolveInstallState(m.paths, { version: "0.2.0" })).toBe("install");
  });

  it("installs when missing or older, skips the same version", () => {
    expect(resolveInstallState(machine().paths, { version: "0.2.0" })).toBe("install");
    expect(resolveInstallState(machine({ installed: "0.1.9" }).paths, { version: "0.2.0" })).toBe(
      "install",
    );
    expect(resolveInstallState(machine({ installed: "0.2.0" }).paths, { version: "0.2.0" })).toBe(
      "up-to-date",
    );
    expect(resolveInstallState(machine().paths, null)).toBe("no-bundle");
  });

  it("replaces an older copy completely and puts WorkflowIntegration.node beside main.js", () => {
    const m = machine({ installed: "0.1.9" });
    installResolvePanel(m.bundled, m.paths);
    expect(existsSync(join(m.target, "stale.js"))).toBe(false);
    expect(readFileSync(join(m.target, "main.js"), "utf8")).toBe("main.js");
    expect(readFileSync(join(m.target, "WorkflowIntegration.node"), "utf8")).toBe("native module");
    expect(readFileSync(join(m.target, "manifest.xml"), "utf8")).toContain("0.2.0");
  });
});
