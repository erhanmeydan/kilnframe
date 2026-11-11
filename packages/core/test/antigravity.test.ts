import { describe, expect, it } from "vitest";
import {
  agyModelSeesImages,
  antigravityPrompt,
  parseAgyModels,
  readAgyResult,
} from "../src/providers/antigravity.js";

describe("Antigravity CLI", () => {
  it("reads the model list agy models prints", () => {
    const out =
      "Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\n" +
      "claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n";
    const models = parseAgyModels(out);
    expect(models.map((m) => m.id)).toEqual([
      "gemini-3.8-flash-high",
      "claude-opus-4-6-thinking",
      "gpt-oss-120b-medium",
    ]);
    expect(models.filter((m) => agyModelSeesImages(m.id)).map((m) => m.id)).toEqual([
      "gemini-3.8-flash-high",
      "claude-opus-4-6-thinking",
    ]);
  });

  it("takes the result line of a stream-json run", () => {
    const out = [
      '{"event":"init","conversation_id":"c"}',
      '{"event":"step_update","step_update":{"text_delta":"o"}}',
      '{"event":"result","result":{"status":"SUCCESS","response":"ok\\n","usage":{"input_tokens":10,"output_tokens":3,"cache_read_tokens":4}}}',
    ].join("\n");
    expect(readAgyResult(out)).toEqual({
      status: "SUCCESS",
      response: "ok\n",
      usage: { input_tokens: 10, output_tokens: 3, cache_read_tokens: 4 },
    });
    expect(readAgyResult("error: flag needs an argument")).toBeNull();
  });

  it("puts the system text, the message and the pictures to open in one prompt", () => {
    const prompt = antigravityPrompt(
      {
        purpose: "plan",
        system: "You plan scenes.",
        messages: [{ role: "user", content: [{ type: "text", text: "Plan this." }] }],
      } as Parameters<typeof antigravityPrompt>[0],
      ["/t/images/image-1.png"],
    );
    expect(prompt).toContain("<instructions>\nYou plan scenes.\n</instructions>");
    expect(prompt).toContain("<user>\nPlan this.\n</user>");
    expect(prompt).toContain("/t/images/image-1.png");
  });
});

describe("Antigravity capacity", () => {
  it("reads how long a capacity error says to wait", async () => {
    const { capacityWaitMs } = await import("../src/providers/antigravity.js");
    const msg =
      "API error (attempt 1): RESOURCE_EXHAUSTED (code 429): You have exhausted your capacity on this model. Resets in 0s.";
    // a short pause even when it says 0 s, so the next try does not hit the same moment
    expect(capacityWaitMs(msg)).toBe(5_000);
    expect(capacityWaitMs("RESOURCE_EXHAUSTED (code 429): Resets in 40s.")).toBe(45_000);
    expect(capacityWaitMs("RESOURCE_EXHAUSTED (code 429): no time given")).toBe(30_000);
    // a wait of hours is a quota for the day: not worth holding the job for
    expect(capacityWaitMs("RESOURCE_EXHAUSTED: Resets in 3h20m.")).toBeNull();
    expect(capacityWaitMs("some other error")).toBeNull();
  });

  it("sends one request at a time", async () => {
    const { oneAtATime } = await import("../src/providers/antigravity.js");
    const run = oneAtATime();
    let running = 0;
    let most = 0;
    const task = () =>
      run(async () => {
        running++;
        most = Math.max(most, running);
        await new Promise((r) => setTimeout(r, 10));
        running--;
      });
    await Promise.all([task(), task(), task()]);
    expect(most).toBe(1);
  });
});
