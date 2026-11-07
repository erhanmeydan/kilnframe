import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Hyperframes from "../src/hyperframes.js";
import { parseCheckJson } from "../src/hyperframes.js";
import type { TextProvider } from "../src/providers/types.js";
import { PlanSchema } from "../src/schemas/plan.js";
import type { ComposeContext, ComposedScene } from "../src/stages/compose.js";
import { validateAndRepair } from "../src/stages/run.js";

// the checks the loop gets, in turn; no HyperFrames, no Chrome
const checks: string[] = [];
let checked = 0;
vi.mock("../src/hyperframes.js", async (actual) => {
  const real = await actual<typeof Hyperframes>();
  return {
    ...real,
    checkProject: () => {
      const json = checks[Math.min(checked++, checks.length - 1)] as string;
      return Promise.resolve({ ...real.parseCheckJson(json), ms: 1 });
    },
  };
});
vi.mock("../src/empty.js", () => ({ emptySceneFindings: () => Promise.resolve([]) }));

const golden = join(import.meta.dirname, "..", "..", "..", "examples", "golden", "flat-infografik");
const silent = JSON.stringify({ ok: false, layout: { ok: false, errorCount: 0, findings: [] } });
const passed = JSON.stringify({ ok: true, layout: { ok: true, errorCount: 0, findings: [] } });

const made: string[] = [];
beforeEach(() => {
  checks.length = 0;
  checked = 0;
});
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function loop() {
  const plan = PlanSchema.parse(JSON.parse(readFileSync(join(golden, "plan.json"), "utf8")));
  const html = readFileSync(join(golden, "scenes", "s1.html"), "utf8");
  const composed = new Map<string, ComposedScene>([["s1", { id: "s1", html, messages: [] }]]);
  const asked = vi.fn(() => Promise.reject(new Error("no scene is sent to repair")));
  const provider = { complete: asked } as unknown as TextProvider;
  const outDir = mkdtempSync(join(tmpdir(), "kf-repair-"));
  made.push(outDir);
  const ctx = {
    provider,
    plan,
    transcript: { language: "tr", words: [] },
    style: {},
  } as unknown as ComposeContext;
  return {
    asked,
    run: () => validateAndRepair({ ctx, plan, composed, outDir, maxRounds: 3, log: () => {} }),
  };
}

describe("validateAndRepair, a check that failed without saying why", () => {
  it("is checked once more, and passes when the second check does, with no scene sent to repair", async () => {
    expect(parseCheckJson(silent).errors[0]?.message).toBe("The check failed without saying why.");
    checks.push(silent, passed);
    const { run, asked } = loop();
    await expect(run()).resolves.toBe(0);
    expect(checked).toBe(2);
    expect(asked).not.toHaveBeenCalled();
  });

  it("gives up with that note when the second check fails without saying why too", async () => {
    checks.push(silent, silent);
    const { run, asked } = loop();
    await expect(run()).rejects.toThrow(/failed without saying why/);
    expect(checked).toBe(2);
    expect(asked).not.toHaveBeenCalled();
  });
});
