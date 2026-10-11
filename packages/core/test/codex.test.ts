import { describe, expect, it } from "vitest";
import {
  CodexProvider,
  codexPrompt,
  createTextProvider,
  loadDefaults,
  readCodexEvents,
} from "../src/index.js";

describe("codex", () => {
  it("reads the reply, the tokens and an error from codex exec's JSON lines", () => {
    const out = [
      '{"type":"thread.started","thread_id":"x"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Red"}}',
      '{"type":"turn.completed","usage":{"input_tokens":20175,"cached_input_tokens":13184,"output_tokens":5}}',
    ].join("\n");
    expect(readCodexEvents(out)).toEqual({
      text: "Red",
      usage: { input: 20175, cached: 13184, output: 5 },
      error: null,
    });
    expect(readCodexEvents('{"type":"turn.failed","error":{"message":"usage limit"}}').error).toBe(
      "usage limit",
    );
  });

  it("puts the system text and the messages in one prompt and says how many images come", () => {
    const p = codexPrompt(
      {
        system: "You plan inserts.",
        messages: [{ role: "user", content: [{ type: "text", text: "Plan this." }] }],
        maxTokens: 100,
        purpose: "plan",
      },
      2,
    );
    expect(p).toContain("<instructions>\nYou plan inserts.\n</instructions>");
    expect(p).toContain("2 image(s) are attached");
    expect(p).toContain("<user>\nPlan this.\n</user>");
  });

  it("is chosen as the codex provider, with Codex's own model when none is named", () => {
    const p = createTextProvider(loadDefaults(), { provider: "codex" });
    expect(p).toBeInstanceOf(CodexProvider);
    expect(p.model).toBe("");
    expect(p.billing).toBe("plan");
  });
});
