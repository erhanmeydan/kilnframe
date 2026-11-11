import { describe, expect, it } from "vitest";
import { isPlanLimit, readClaudeCodeResult } from "../src/providers/claude-code.js";
import { codexErrorRetryable } from "../src/providers/codex.js";
import { ProviderError } from "../src/providers/types.js";

const ctx = { model: "claude-opus-5-5", purpose: "compose" };
const result = (o: Record<string, unknown>) => ({
  code: 0,
  stderr: "",
  stdout: JSON.stringify({ subtype: "success", is_error: false, result: "ok", ...o }),
});
const thrown = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e as ProviderError;
  }
  throw new Error("did not throw");
};

describe("Claude Code result", () => {
  it("throws a retryable cut-off when the reply hit the output limit", () => {
    const e = thrown(() => readClaudeCodeResult(result({ stop_reason: "max_tokens" }), ctx));
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.retryable).toBe(true);
    expect(e.kind).toBe("cut-off");
  });

  it("stops on the plan limit but tries a rate limit or overload again", () => {
    expect(isPlanLimit("Claude AI usage limit reached|1762891200")).toBe(true);
    expect(isPlanLimit("You've hit your limit · resets 3pm (Europe/Istanbul)")).toBe(true);
    expect(isPlanLimit("API Error: 429 rate_limit_error: Number of request tokens exceeded")).toBe(
      false,
    );
    expect(isPlanLimit("API Error: 529 overloaded_error")).toBe(false);
    expect(isPlanLimit("Prompt is too long: input exceeds the context limit")).toBe(false);
    const e = thrown(() =>
      readClaudeCodeResult(
        result({ is_error: true, subtype: "error", result: "API Error: 429 rate_limit_error" }),
        ctx,
      ),
    );
    expect(e.retryable).toBe(true);
    const plan = thrown(() =>
      readClaudeCodeResult(
        result({ is_error: true, subtype: "error", result: "Claude AI usage limit reached" }),
        ctx,
      ),
    );
    expect(plan.retryable).toBe(false);
  });
});

describe("Codex errors", () => {
  it("tries a passing error again and stops on the usage limit", () => {
    expect(codexErrorRetryable("stream error: exceeded retry limit, last status: 429")).toBe(true);
    expect(codexErrorRetryable("Rate limit reached for gpt-5.5")).toBe(true);
    expect(codexErrorRetryable("You've hit your usage limit. Try again in 3 days.")).toBe(false);
    // "rate" inside "generate" is not a rate limit
    expect(codexErrorRetryable("Could not generate a reply: invalid request")).toBe(false);
  });
});
