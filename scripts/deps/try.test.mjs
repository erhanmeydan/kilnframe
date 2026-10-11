import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyBump, reportMarkdown, worktreeBase } from "./try.mjs";

describe("applyBump", () => {
  it("pins an npm dependency exactly in its package.json and in deps.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "kf-bump-"));
    mkdirSync(join(dir, "packages/core"), { recursive: true });
    writeFileSync(
      join(dir, "packages/core/package.json"),
      JSON.stringify({ dependencies: { hyperframes: "0.8.133" } }),
    );
    const dep = {
      id: "hyperframes",
      group: "render",
      current: "0.8.133",
      source: { type: "npm", package: "hyperframes" },
      files: ["packages/core/package.json"],
    };
    writeFileSync(join(dir, "deps.json"), JSON.stringify({ deps: [dep] }));
    const edited = applyBump(dir, dep, "0.8.140");
    expect(
      JSON.parse(readFileSync(join(dir, "packages/core/package.json"), "utf8")).dependencies
        .hyperframes,
    ).toBe("0.8.140");
    expect(JSON.parse(readFileSync(join(dir, "deps.json"), "utf8")).deps[0].current).toBe(
      "0.8.140",
    );
    expect(edited).toEqual(["packages/core/package.json", "deps.json"]);
  });
  it("keeps a caret range a caret range", () => {
    const dir = mkdtempSync(join(tmpdir(), "kf-bump-"));
    mkdirSync(join(dir, "packages/app"), { recursive: true });
    writeFileSync(
      join(dir, "packages/app/package.json"),
      JSON.stringify({ devDependencies: { electron: "^44.7.0" } }),
    );
    const dep = {
      id: "electron",
      group: "app",
      current: "44.7.0",
      source: { type: "npm", package: "electron" },
      files: ["packages/app/package.json"],
    };
    writeFileSync(join(dir, "deps.json"), JSON.stringify({ deps: [dep] }));
    applyBump(dir, dep, "44.8.0");
    expect(
      JSON.parse(readFileSync(join(dir, "packages/app/package.json"), "utf8")).devDependencies
        .electron,
    ).toBe("^44.8.0");
  });
  it("refuses a source it cannot bump by itself and says what to do", () => {
    const dep = { id: "ffmpeg-mac", current: "1", source: { type: "ffmpeg-riedl" }, files: [] };
    expect(() => applyBump(tmpdir(), dep, "2")).toThrow(/ffmpeg\.mjs/);
  });
});

describe("worktreeBase", () => {
  it("branches from origin/main, never from the dirty working tree", () => {
    expect(worktreeBase({})).toBe("origin/main");
  });
  it("can start from another commit when asked (before the scripts reach main)", () => {
    expect(worktreeBase({ DEPS_TRY_BASE: "deps-watch" })).toBe("deps-watch");
  });
});

describe("reportMarkdown", () => {
  it("lists steps, scene results and the verdict in Turkish", () => {
    const md = reportMarkdown({
      dep: { id: "hyperframes" },
      from: "0.8.133",
      to: "0.8.140",
      steps: [{ name: "pnpm check", ok: true }],
      scenes: [
        {
          name: "kil-lacivert",
          pass: false,
          frames: [{ t: 1.2, mean: 3.1, changed: 0.04, image: "kil-lacivert/f00.png" }],
          ms: { old: 40000, new: 36000 },
        },
      ],
    });
    expect(md).toContain("hyperframes 0.8.133 → 0.8.140");
    expect(md).toContain("| kil-lacivert | farklı |");
    expect(md).toContain("![kil-lacivert 1.20 s](kil-lacivert/f00.png)");
    expect(md).toContain("Sonuç: PR açılmadı");
    expect(md).not.toMatch(/[—–]/);
  });
});
