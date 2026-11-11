import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../src/providers/anthropic.js";

describe("Anthropic errors", () => {
  it("says a lost connection is a connection problem", async () => {
    const p = new AnthropicProvider({ model: "claude-opus-5-5", effort: "high", apiKey: "k" });
    // the SDK's stream, replaced so nothing goes over the network
    (p as unknown as { client: unknown }).client = {
      beta: {
        messages: {
          stream: () => ({
            finalMessage: () =>
              Promise.reject(new Anthropic.APIConnectionError({ message: "Connection error." })),
          }),
        },
      },
    };
    const err = await p
      .complete({ system: "s", messages: [], maxTokens: 10, purpose: "plan" })
      .catch((e: unknown) => e as Error & { retryable: boolean });
    expect(err.message).toMatch(/Could not reach the Anthropic API/);
    expect(err.retryable).toBe(true);
  });

  it("hands the caller's signal to the SDK, and a cancelled call ends as cancelled", async () => {
    const p = new AnthropicProvider({ model: "claude-opus-5-5", effort: "high", apiKey: "k" });
    const stop = new AbortController();
    let given: AbortSignal | undefined;
    (p as unknown as { client: unknown }).client = {
      beta: {
        messages: {
          stream: (_body: unknown, options?: { signal?: AbortSignal }) => {
            given = options?.signal;
            return {
              finalMessage: () =>
                new Promise((_, reject) =>
                  options?.signal?.addEventListener("abort", () =>
                    reject(new Anthropic.APIUserAbortError()),
                  ),
                ),
            };
          },
        },
      },
    };
    const asked = p.complete({
      system: "s",
      messages: [],
      maxTokens: 10,
      purpose: "plan",
      signal: stop.signal,
    });
    stop.abort(new Error("Cancelled"));
    await expect(asked).rejects.toThrow("Cancelled");
    expect(given).toBe(stop.signal);
  });
});
