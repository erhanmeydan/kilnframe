import { describe, expect, it } from "vitest";
import { claudeCodeArgs } from "../src/providers/claude-code.js";

describe("claudeCodeArgs", () => {
  it("turns the editor's own Claude Code hooks off", () => {
    const args = claudeCodeArgs({
      model: "claude-opus-5-5",
      effort: "high",
      system: "s",
      hasImages: false,
    });
    const settings = args[args.indexOf("--settings") + 1];
    expect(JSON.parse(settings as string)).toEqual({ disableAllHooks: true });
    expect(args).toContain("--strict-mcp-config");
  });

  it("sends images as stream-json", () => {
    const args = claudeCodeArgs({ model: "m", effort: "high", system: "s", hasImages: true });
    expect(args).toEqual(expect.arrayContaining(["--input-format", "stream-json", "--verbose"]));
  });
});
