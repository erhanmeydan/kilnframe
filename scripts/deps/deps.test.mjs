import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hyperframesChrome, pinnedVersion } from "./pins.mjs";
import { loadDeps } from "./versions.mjs";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

describe("deps.json", () => {
  const deps = loadDeps(root);
  it("has unique ids and known groups", () => {
    expect(new Set(deps.map((d) => d.id)).size).toBe(deps.length);
    for (const d of deps) expect(["render", "app", "dev"]).toContain(d.group);
  });
  it.each(deps.filter((d) => d.current !== "-"))("$id matches the file that pins it", (d) => {
    const real = pinnedVersion(root, d);
    if (real !== null) expect(d.current).toBe(real);
  });
  it("tracks the Chrome HyperFrames pins", () => {
    expect(deps.find((d) => d.id === "chrome-headless-shell").current).toBe(
      hyperframesChrome(root),
    );
  });
});
