import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Hyperframes from "../src/hyperframes.js";
import { rootHtml } from "../src/project/assemble.js";
import { PlanSchema } from "../src/schemas/plan.js";
import { renderPlan } from "../src/stages/render.js";

// the stills are where this test stops: what renderPlan did to the project before them is what it reads
vi.mock("../src/hyperframes.js", async (actual) => ({
  ...(await actual<typeof Hyperframes>()),
  snapshotProject: () => Promise.reject(new Error("stopped at the stills")),
}));

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const goldenPlan = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "examples",
  "golden",
  "flat-infografik",
  "plan.json",
);

describe("renderPlan of a project checked before", () => {
  it("writes the root page anew, so a job checked under an older core gets today's (the buildReady guard)", async () => {
    const plan = PlanSchema.parse(JSON.parse(readFileSync(goldenPlan, "utf8")));
    const outDir = mkdtempSync(join(tmpdir(), "kf-render-plan-"));
    made.push(outDir);
    mkdirSync(join(outDir, "project"));
    // the root a job approved before the update was checked with: no guard, the old haze selector
    writeFileSync(
      join(outDir, "project", "index.html"),
      "<!doctype html><html><body>old root</body></html>",
    );
    await expect(
      renderPlan({ plan, scenes: {}, outDir, prechecked: true, stillsOnly: true }),
    ).rejects.toThrow("stopped at the stills");
    expect(readFileSync(join(outDir, "project", "index.html"), "utf8")).toBe(rootHtml(plan));
  });
});
