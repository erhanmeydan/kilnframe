import { describe, expect, it } from "vitest";
import { CODEX_ISOLATION } from "../src/providers/codex.js";

describe("CODEX_ISOLATION", () => {
  it("keeps the editor's config.toml (MCP servers, plugins, hooks, turn-end program) out of Kilnframe's calls", () => {
    expect(CODEX_ISOLATION).toEqual(["--ignore-user-config"]);
  });
});
