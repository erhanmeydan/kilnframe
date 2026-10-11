// Copies the repo's vendor/ folder into a composition project so it renders without network access.
// Usage: node scripts/sync-vendor.mjs <project-dir>
import { cpSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const target = process.argv[2];
if (!target) {
  console.error("Usage: node scripts/sync-vendor.mjs <project-dir>");
  process.exit(1);
}
const projectDir = resolve(target);
if (!existsSync(projectDir)) {
  console.error(`Project directory not found: ${projectDir}`);
  process.exit(1);
}
const vendorDir = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor");
cpSync(vendorDir, join(projectDir, "vendor"), { recursive: true });
console.log(`vendor -> ${join(projectDir, "vendor")}`);
