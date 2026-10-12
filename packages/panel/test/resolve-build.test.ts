import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const panel = join(__dirname, "..");
const out = join(panel, "dist-resolve");
const version = JSON.parse(readFileSync(join(panel, "public", "manifest.json"), "utf8")).version;

describe("resolve build", () => {
  beforeAll(() => {
    execFileSync("pnpm", ["build"], { cwd: panel, stdio: "ignore" });
  }, 120_000);

  it("writes a Workflow Integration plugin folder", () => {
    for (const f of [
      "manifest.xml",
      "index.html",
      "index.js",
      "main.js",
      "preload.js",
      "icons/mark@2x.png",
    ])
      expect(existsSync(join(out, f)), f).toBe(true);
  });

  it("names the plugin and its entry, with the panel's version", () => {
    const xml = readFileSync(join(out, "manifest.xml"), "utf8");
    expect(xml).toContain("<Id>com.kilnframe.resolve</Id>");
    expect(xml).toContain("<Name>Kilnframe</Name>");
    expect(xml).toContain("<FilePath>main.js</FilePath>");
    expect(xml).toContain(`<Version>${version}</Version>`);
  });

  it("keeps the two hosts apart", () => {
    const page = readFileSync(join(out, "index.js"), "utf8");
    expect(page).not.toContain('require("premierepro")');
    expect(page).toContain("kilnframeResolve");
    expect(readFileSync(join(panel, "dist", "index.js"), "utf8")).not.toContain("kilnframeResolve");
  });

  it("makes the page one self-contained script (a sandboxed Electron page has no require)", () => {
    expect(readFileSync(join(out, "index.js"), "utf8")).not.toMatch(/\brequire\(/);
  });

  it("loads WorkflowIntegration.node beside main.js, which the app copies from Resolve", () => {
    expect(readFileSync(join(out, "main.js"), "utf8")).toContain("./WorkflowIntegration.node");
  });
});
