// Speech recognition on Intel Macs. onnxruntime-node stopped shipping a macOS x64 library after 1.23.2, and
// Microsoft no longer builds one, so the installed onnxruntime-node gets that release's darwin/x64 binding
// beside its own platforms. Its JavaScript side is unchanged since: 1.30 passes initOrtOnce one more
// argument (isMainThread), which the 1.23.2 binding ignores.
// `node packages/app/scripts/onnxruntime-x64.mjs` adds it to the workspace's copy (development, tests);
// stage.mjs adds it to the production copy.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "1.23.2";
const URL_ = `https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-${VERSION}.tgz`;
// the registry's dist.integrity for the tarball
const SHA512 =
  "OBTsG0W8ddBVOeVVVychpVBS87A9YV5sa2hJ6lc025T97Le+J4v++PwSC4XFs1C62SWyNdof0Mh4KvnZgtt4aw==";

/** Puts the darwin/x64 binding into `ortDir` (an onnxruntime-node package folder) when it has none. */
export async function addOnnxruntimeX64(ortDir) {
  const target = join(ortDir, "bin", "napi-v6", "darwin", "x64");
  if (existsSync(join(target, "onnxruntime_binding.node"))) return target;
  const cache = join(homedir(), ".cache", "kilnframe-onnxruntime", VERSION);
  mkdirSync(cache, { recursive: true });
  const tgz = join(cache, `onnxruntime-node-${VERSION}.tgz`);
  const sum = () => createHash("sha512").update(readFileSync(tgz)).digest("base64");
  if (!existsSync(tgz) || sum() !== SHA512) {
    console.log(`downloading ${URL_}`);
    const res = await fetch(URL_);
    if (!res.ok) throw new Error(`${URL_}: HTTP ${res.status}`);
    writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
  }
  if (sum() !== SHA512) throw new Error(`${tgz}: SHA-512 does not match the registry's`);
  const out = join(cache, "x");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out);
  execFileSync("tar", ["-xzf", tgz, "-C", out, "package/bin/napi-v6/darwin/x64"]);
  cpSync(join(out, "package", "bin", "napi-v6", "darwin", "x64"), target, { recursive: true });
  return target;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const core = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "core", "package.json");
  // onnxruntime-node is a dependency of transformers.js, which core depends on; neither exports its
  // package.json, so walk up from the resolved entry files
  const root = (file, name) => {
    let dir = dirname(file);
    while (!existsSync(join(dir, "package.json")) || !dir.endsWith(name)) dir = dirname(dir);
    return dir;
  };
  const transformers = root(
    createRequire(core).resolve("@huggingface/transformers"),
    "transformers",
  );
  const ort = root(
    createRequire(join(transformers, "package.json")).resolve("onnxruntime-node"),
    "onnxruntime-node",
  );
  console.log(`onnxruntime ${VERSION} darwin/x64 -> ${await addOnnxruntimeX64(ort)}`);
}
