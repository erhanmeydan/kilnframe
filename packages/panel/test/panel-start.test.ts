import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeModelSuccessor } from "../src/provider-settings";

const source = readFileSync(join(__dirname, "..", "src", "app.ts"), "utf8");

/** The body of a function declared in app.ts, by brace counting. */
function body(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) return "";
  const open = source.indexOf("{", source.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  return "";
}

describe("panel start", () => {
  it("reads the saved settings with nothing declared later in app.ts", () => {
    // the bundle turns app.ts's top-level consts into vars: one read before its line is undefined, and the
    // settings fell back to the defaults on every start (0.5.0 to 0.7.0)
    const stateAt = source.indexOf("const state = {");
    const stateEnd = source.indexOf("\n};", stateAt);
    const calls = [...source.slice(stateAt, stateEnd).matchAll(/\b([a-zA-Z]\w*)\(/g)].map(
      (m) => m[1]!,
    );
    const late: string[] = [];
    for (const fn of new Set(calls)) {
      for (const [, name] of body(fn).matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) {
        const at = source.search(new RegExp(`^(const|let) ${name}\\b`, "m"));
        if (at > stateAt) late.push(`${fn} uses ${name!}`);
      }
    }
    expect(calls).toContain("loadSettings");
    expect(late).toEqual([]);
  });

  it("moves a Claude model the list no longer offers to its successor", () => {
    expect(claudeModelSuccessor("claude-fable-5-1")).toBe("claude-fable-5-2");
    expect(claudeModelSuccessor("claude-opus-5-5")).toBe("claude-opus-5-5");
  });
});
