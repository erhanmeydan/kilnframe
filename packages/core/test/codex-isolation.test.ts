import { describe, expect, it } from "vitest";
import { CODEX_ISOLATION } from "../src/providers/codex.js";

describe("CODEX_ISOLATION", () => {
  it("keeps the editor's MCP servers, turn-end program and hooks out of Kilnframe's calls", () => {
    expect(CODEX_ISOLATION).toEqual([
      "-c",
      "mcp_servers={}",
      "-c",
      "notify=[]",
      "-c",
      "features.hooks=false",
    ]);
  });
});
