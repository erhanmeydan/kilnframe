import { describe, expect, it } from "vitest";
import { withoutHostSession } from "../src/providers/claude-code.js";

describe("withoutHostSession", () => {
  it("drops what a running Claude Code session hands its children, keeps the editor's own settings", () => {
    const env = withoutHostSession({
      HOME: "/Users/e",
      PATH: "/usr/bin",
      CLAUDECODE: "1",
      CLAUDE_PID: "25246",
      AI_AGENT: "claude-code",
      CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/1.sock",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_AGENT_SDK_VERSION: "0.3",
      CLAUDE_CONFIG_DIR: "/Users/e/.claude-test",
      CLAUDE_CODE_OAUTH_TOKEN: "token",
      CLAUDE_CODE_USE_BEDROCK: "1",
      ANTHROPIC_BASE_URL: "https://proxy.example",
    });
    expect(Object.keys(env).sort()).toEqual([
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CONFIG_DIR",
      "HOME",
      "PATH",
    ]);
  });
});
