import { describe, expect, it } from "vitest";
import { loginCommand, logoutArgs } from "../src/agent-commands.js";

describe("agent sign-in and sign-out commands", () => {
  it("signs in with each CLI's own command", () => {
    expect(loginCommand("claude-code", {}, "darwin")).toBe("claude auth login");
    expect(loginCommand("codex", {}, "darwin")).toBe("codex login");
    expect(loginCommand("grok", {}, "darwin")).toBe("grok login --oauth");
  });

  it("signs in to the profile folder the companion uses, for every agent", () => {
    const env = { CLAUDE_CONFIG_DIR: "/p/claude", CODEX_HOME: "/p/codex", GROK_HOME: "/p/grok" };
    expect(loginCommand("claude-code", env, "darwin")).toBe(
      "CLAUDE_CONFIG_DIR='/p/claude' claude auth login",
    );
    expect(loginCommand("codex", env, "darwin")).toBe("CODEX_HOME='/p/codex' codex login");
    expect(loginCommand("grok", env, "darwin")).toBe("GROK_HOME='/p/grok' grok login --oauth");
    expect(loginCommand("codex", env, "win32")).toBe('set "CODEX_HOME=/p/codex" && codex login');
  });

  it("signs out with each CLI's own command", () => {
    expect(logoutArgs("claude-code")).toEqual(["auth", "logout"]);
    expect(logoutArgs("codex")).toEqual(["logout"]);
    expect(logoutArgs("grok")).toEqual(["logout"]);
  });
});
