// pnpm patches (pnpm-workspace.yaml's patchedDependencies) carried into the packaged app, and checked there.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** The repository's pnpm patches: [{ name, version, file }] from pnpm-workspace.yaml's patchedDependencies. */
export function pnpmPatches(root) {
  const yaml = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  const block = yaml.split(/^patchedDependencies:\s*$/m)[1] ?? "";
  const out = [];
  for (const line of block.split("\n")) {
    if (line && !line.startsWith(" ")) break;
    const m = line.match(/^\s+(@?[^@\s]+)@([^:\s]+):\s*(\S+)/);
    if (m) out.push({ name: m[1], version: m[2], file: join(root, m[3]) });
  }
  return out;
}

/** Every copy of a patched package under node_modules: the hoisted one and the virtual store's. */
export function patchedCopies(nodeModules, { name, version }) {
  const dirs = [join(nodeModules, name)];
  const store = join(nodeModules, ".pnpm");
  const prefix = `${name.replace("/", "+")}@${version}`;
  if (existsSync(store))
    for (const d of readdirSync(store))
      if (d === prefix || d.startsWith(`${prefix}_`))
        dirs.push(join(store, d, "node_modules", name));
  return dirs.filter((d) => existsSync(join(d, "package.json")));
}

/** git apply on a folder as a plain patch tool: the ceiling keeps git from finding this repository. */
function gitApply(dir, args) {
  execFileSync("git", ["apply", ...args], {
    cwd: dir,
    stdio: "ignore",
    env: { ...process.env, GIT_CEILING_DIRECTORIES: join(dir, "..") },
  });
}
const isPatched = (dir, file) => {
  try {
    gitApply(dir, ["--reverse", "--check", file]);
    return true;
  } catch {
    return false;
  }
};

/**
 * Patches every copy of a patched package in the app's node_modules that lacks its patch. pnpm patches the
 * repository's install, but electron-builder fills the app from pnpm's store, unpatched: the HyperFrames
 * alpha speed-up went missing in a trial build. Runs from electron-builder's afterPack, before signing.
 */
export function patchApp(root, appNodeModules) {
  for (const p of pnpmPatches(root))
    for (const dir of patchedCopies(appNodeModules, p))
      if (!isPatched(dir, p.file)) {
        gitApply(dir, [p.file]);
        console.log(`patched ${p.name}@${p.version} in ${dir}`);
      }
}

/** Stops the build when the packaged app carries a patched package without its patch. */
export function checkAppPatched(root, appNodeModules) {
  for (const p of pnpmPatches(root)) {
    const dirs = patchedCopies(appNodeModules, p);
    if (!dirs.length) throw new Error(`${p.name}@${p.version} is not in ${appNodeModules}`);
    for (const dir of dirs)
      if (!isPatched(dir, p.file)) throw new Error(`the app's ${dir} lacks ${p.file}`);
  }
}
