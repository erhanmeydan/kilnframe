// Builds Kilnframe Helper for this platform: a flat production copy of the app (pnpm deploy), the bundled
// tools (FFmpeg, FFprobe, the headless Chrome HyperFrames renders with), the styles and vendor libraries,
// then electron-builder. `node scripts/stage.mjs` makes an unpacked app (quick test);
// `--dmg` makes the disk image, `--pkg` the macOS installer (with `--plugin-id kilnframe-test` for a test build
// beside the development plugin). On macOS it signs with the Developer ID (`--unsigned`
// skips it) and notarizes with APPLE_KEYCHAIN_PROFILE=kilnframe-notary.
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const app = fileURLToPath(new URL("..", import.meta.url));
const root = join(app, "..", "..");
const stage = join(root, "out", "app-stage");
const extra = join(stage, "extra");
const require = createRequire(join(app, "package.json"));
// on Windows pnpm and electron-builder are .cmd files, which Node starts only through a shell
const run = (cmd, args, cwd = root) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
const platform =
  process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : null;
if (!platform) throw new Error("Kilnframe Helper is built on macOS or Windows.");
const arch = process.arch; // arm64 or x64; one build per architecture

console.log("1/4 production copy");
run("pnpm", ["-r", "build"]);
rmSync(stage, { recursive: true, force: true });
run("pnpm", [
  "--filter",
  "@kilnframe/app",
  "deploy",
  "--prod",
  "--legacy",
  "--config.node-linker=hoisted",
  stage,
]);
// deploy writes its own settings (hoisted, production) into the workspace's install state; a plain
// install puts the repository's back so the next pnpm command does not try to reinstall everything
run("pnpm", ["install", "--offline"]);

console.log("2/4 bundled tools");
const bin = join(extra, "bin");
mkdirSync(bin, { recursive: true });
const exe = (name) => (platform === "win" ? `${name}.exe` : name);
cpSync(require("ffmpeg-static"), join(bin, exe("ffmpeg")));
cpSync(require("@ffprobe-installer/ffprobe").path, join(bin, exe("ffprobe")));
// the headless Chrome HyperFrames already uses on this computer (same build), from Puppeteer's cache
const shells = join(homedir(), ".cache", "puppeteer", "chrome-headless-shell");
const prefix = platform === "mac" ? (arch === "arm64" ? "mac_arm-" : "mac-") : "win64-";
const build = readdirSync(shells)
  .filter((d) => d.startsWith(prefix))
  .sort()
  .at(-1);
if (!build)
  throw new Error(`No headless Chrome for ${prefix} in ${shells}; render once to fetch it.`);
const shellDir = readdirSync(join(shells, build)).find((d) =>
  d.startsWith("chrome-headless-shell"),
);
// not bin/chrome-headless-shell/: a folder named like its executable makes codesign take it for a bundle
// and refuse the unsigned data files beside the binary
cpSync(join(shells, build, shellDir), join(bin, "headless-shell"), { recursive: true });
cpSync(join(root, "styles"), join(extra, "styles"), { recursive: true });
cpSync(join(root, "vendor"), join(extra, "vendor"), { recursive: true });
// the licenses NOTICE points to; FFmpeg's GPL text has to travel with the program
const licenses = join(extra, "licenses");
mkdirSync(licenses, { recursive: true });
for (const f of ["LICENSE", "NOTICE"]) cpSync(join(root, f), join(licenses, f));
// FFmpeg's own license notes and the GPL text it ships under, kept in the repository (the Windows build of
// ffmpeg-static has no license file)
for (const f of readdirSync(join(app, "build", "licenses")))
  cpSync(join(app, "build", "licenses", f), join(licenses, f));

// the Premiere panel as a .ccx, which the app installs with Adobe's installer (src/plugin.ts). A different id
// (--plugin-id kilnframe-test) lets the packaged plugin sit beside the development one loaded by UDT.
// one version for the app and its plugin: package.json, or --version 0.1.1 (update tests)
const versionArg = process.argv.indexOf("--version");
const version =
  versionArg > 0
    ? process.argv[versionArg + 1]
    : JSON.parse(readFileSync(join(app, "package.json"), "utf8")).version;
const pluginIdArg = process.argv.indexOf("--plugin-id");
const pluginId = pluginIdArg > 0 ? process.argv[pluginIdArg + 1] : "kilnframe";
const pluginStage = join(stage, "plugin-src");
cpSync(join(root, "packages", "panel", "dist"), pluginStage, { recursive: true });
for (const f of readdirSync(pluginStage)) if (f.endsWith(".map")) rmSync(join(pluginStage, f));
const manifestPath = join(pluginStage, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.version = version;
if (pluginId !== "kilnframe") {
  manifest.id = pluginId;
  manifest.name = `${manifest.name} Test`;
  for (const e of manifest.entrypoints) e.label.default = `${e.label.default} Test`;
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
const pluginDir = join(extra, "plugin");
mkdirSync(pluginDir, { recursive: true });
const ccx = `${pluginId}.ccx`;
run("tar", ["--format=zip", "-cf", join(pluginDir, ccx), "-C", pluginStage, "."]);
writeFileSync(
  join(pluginDir, "plugin.json"),
  JSON.stringify(
    { file: ccx, id: pluginId, name: manifest.name, version: manifest.version },
    null,
    2,
  ),
);

console.log("3/4 trimming");
const modules = join(stage, "node_modules");
// onnxruntime-node ships every platform's library; keep this platform and architecture. The binding links
// libonnxruntime.1.dylib, so the identical versioned copy beside it is never loaded (44 MB).
const ort = join(modules, "onnxruntime-node", "bin");
if (existsSync(ort))
  for (const napi of readdirSync(ort))
    for (const os of readdirSync(join(ort, napi))) {
      const osDir = join(ort, napi, os);
      if (os !== (platform === "mac" ? "darwin" : "win32")) {
        rmSync(osDir, { recursive: true });
        continue;
      }
      for (const a of readdirSync(osDir)) {
        const archDir = join(osDir, a);
        if (a !== arch) rmSync(archDir, { recursive: true });
        else
          for (const f of readdirSync(archDir))
            if (/^libonnxruntime\.\d+\.\d+\.\d+\.dylib$/.test(f)) rmSync(join(archDir, f));
      }
    }
// Transformers.js bundles the web runtime into its Node build and uses onnxruntime-node in Node; the
// onnxruntime-web package (its WebAssembly files, 149 MB) is never loaded
rmSync(join(modules, "onnxruntime-web"), { recursive: true, force: true });
// source maps and type declarations are for development only
const trim = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) trim(p);
    else if (/\.map$|\.d\.[cm]?ts$/.test(e.name)) rmSync(p);
  }
};
trim(modules);

console.log("4/4 electron-builder");
// the Electron pnpm installed, when its download ran (not on every CI machine); else electron-builder fetches it
const localElectron = join(require.resolve("electron/package.json"), "..", "dist");
const electronDist = existsSync(localElectron) ? localElectron : undefined;
const electronVersion = require("electron/package.json").version;
writeFileSync(
  join(stage, "electron-builder.json"),
  JSON.stringify(
    {
      appId: "com.erhanmeydan.kilnframe",
      productName: "Kilnframe",
      // the name decides the Windows install folder (Programs\Kilnframe) and the app's data folder (Roaming\Kilnframe)
      extraMetadata: { name: "kilnframe", productName: "Kilnframe", version },
      // the app reads its updates from here (app-update.yml); the build itself never uploads (--publish never)
      publish: [{ provider: "github", owner: "erhanmeydan", repo: "kilnframe" }],
      electronVersion,
      ...(electronDist ? { electronDist } : {}),
      asar: false,
      // Electron's switches: the companion and its jobs need Electron to run as Node (ELECTRON_RUN_AS_NODE);
      // nothing needs NODE_OPTIONS, the inspector or file:// privileges, so those are off and another program
      // cannot use them to run code as Kilnframe
      electronFuses: {
        runAsNode: true,
        enableNodeOptionsEnvironmentVariable: false,
        enableNodeCliInspectArguments: false,
        grantFileProtocolExtraPrivileges: false,
        enableCookieEncryption: true,
      },
      directories: { output: join(root, "out", "app-build") },
      files: ["dist/**", "assets/**", "package.json", "node_modules/**"],
      extraResources: [
        { from: "extra/bin", to: "bin" },
        { from: "extra/styles", to: "styles" },
        { from: "extra/vendor", to: "vendor" },
        { from: "extra/plugin", to: "plugin" },
        { from: "extra/licenses", to: "licenses" },
      ],
      mac: {
        category: "public.app-category.video",
        artifactName: "Kilnframe-${version}-mac-${arch}.${ext}",
        icon: join(app, "assets", "icon.icns"),
        // the .zip is what the installed app downloads to update itself
        target: process.argv.includes("--pkg")
          ? ["pkg", "zip"]
          : process.argv.includes("--zip")
            ? ["zip"]
            : process.argv.includes("--dmg")
              ? ["dmg"]
              : ["dir"],
        // a menu bar app: no Dock icon, no window
        extendInfo: { LSUIElement: true },
        // signed with the Developer ID in the login keychain when there is one (--unsigned skips it);
        // notarized when APPLE_KEYCHAIN_PROFILE names a notarytool profile (xcrun notarytool store-credentials)
        identity: process.argv.includes("--unsigned") ? null : "Erhan Meydan (6J2A7G347T)",
        hardenedRuntime: true,
        entitlements: join(app, "build", "entitlements.mac.plist"),
        entitlementsInherit: join(app, "build", "entitlements.mac.plist"),
        notarize: Boolean(process.env.APPLE_KEYCHAIN_PROFILE),
      },
      // the macOS installer: preinstall quits a running Kilnframe, Kilnframe.app goes into /Applications,
      // then postinstall opens it once
      pkg: {
        installLocation: "/Applications",
        isRelocatable: false,
        allowAnywhere: false,
        allowCurrentUserHome: false,
        scripts: join(app, "build", "pkg-scripts"),
        // the same name in every release, so .../releases/latest/download/Kilnframe-mac.pkg is always the newest
        artifactName: "Kilnframe-mac.pkg",
        identity: process.argv.includes("--unsigned") ? null : "Erhan Meydan (6J2A7G347T)",
      },
      win: { target: ["nsis"], icon: join(app, "assets", "icon.png") },
      nsis: { artifactName: "Kilnframe-Windows.exe" },
    },
    null,
    2,
  ),
);
// extended attributes on the installer scripts would go into the .pkg as ._ files beside them
if (platform === "mac") execFileSync("xattr", ["-cr", join(app, "build", "pkg-scripts")]);
run(
  join(
    app,
    "node_modules",
    ".bin",
    platform === "win" ? "electron-builder.cmd" : "electron-builder",
  ),
  [
    "--config",
    "electron-builder.json",
    `--${arch}`,
    platform === "mac" ? "--mac" : "--win",
    "--publish",
    "never",
  ],
  stage,
);

// electron-builder notarizes the app inside; the installer around it is a separate submission
if (platform === "mac" && process.argv.includes("--pkg") && process.env.APPLE_KEYCHAIN_PROFILE) {
  const out = join(root, "out", "app-build");
  const pkg = readdirSync(out)
    .filter((f) => f.endsWith(".pkg"))
    .map((f) => join(out, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (!pkg) throw new Error(`No .pkg in ${out}`);
  console.log(`notarizing ${pkg}`);
  run("xcrun", [
    "notarytool",
    "submit",
    pkg,
    "--keychain-profile",
    process.env.APPLE_KEYCHAIN_PROFILE,
    "--wait",
  ]);
  run("xcrun", ["stapler", "staple", pkg]);
}
