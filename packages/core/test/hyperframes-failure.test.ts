import { describe, expect, it } from "vitest";
import { failureOutput } from "../src/hyperframes.js";

const run = (stderr: string, stdout = "") => ({ code: 1, stderr, stdout, ms: 0 });

describe("failureOutput", () => {
  it("gives a short output whole", () => {
    expect(failureOutput(run("Error: no index.html\n"))).toBe("Error: no index.html");
    expect(failureOutput(run("", "only on stdout"))).toBe("only on stdout");
  });

  it("keeps a crash's cause that a long native stack follows", () => {
    const progress = Array.from(
      { length: 200 },
      (_, i) => `@hf-progress {"code":"capture","done":${i},"total":837}`,
    );
    const stack = Array.from(
      { length: 300 },
      (_, i) => ` ${i}: 0x1${i.toString(16).padStart(8, "0")} node::Abort() [/Electron Framework]`,
    );
    const out = [
      "Checking browser...",
      "[INFO] [Render] Pipeline started",
      "[WARN] [Compiler] System font is large",
      ...progress,
      "<--- Last few GCs --->",
      "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
      "----- Native stack trace -----",
      ...stack,
    ].join("\n");
    const text = failureOutput(run(out));
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(
      text.startsWith(
        "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
      ),
    ).toBe(true);
    // the end is kept as it was, from a whole line
    expect(text.endsWith(stack.at(-1) as string)).toBe(true);
    expect(text).toContain("\n…\n");
    // progress and information lines are not causes
    expect(text).not.toContain("@hf-progress");
    expect(text).not.toContain("[INFO]");
  });

  it("gives the end alone when nothing before it names a failure", () => {
    const out = Array.from({ length: 400 }, (_, i) => `line ${i} of a long log`).join("\n");
    expect(failureOutput(run(out))).toBe(out.slice(-4000));
  });
});
