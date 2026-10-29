import { spawnAgent, spawnAgentSync } from "./agent-binary.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProviderError,
  mentionsUnavailableModel,
  type Capabilities,
  type TextProvider,
  type TextRequest,
  type TextResponse,
} from "./types.js";

/**
 * Uses the official Codex CLI the user installed and signed in to with their ChatGPT account,
 * the way HyperFrames Studio does. The binary runs unmodified in `codex exec`; this code never reads
 * or stores OpenAI credentials, and the ChatGPT plan pays when the CLI is signed in with it.
 *
 * Checked on Codex CLI 0.155.1 (8 Oct 2026): `codex exec --json` prints one JSON event per line, the reply
 * in item.completed events of type agent_message and the token counts in turn.completed; `-i` attaches
 * images and takes several files, so the prompt goes on stdin.
 */

export interface CodexStatus {
  installed: boolean;
  version: string | null;
  loggedIn: boolean;
  /** "chatgpt" (the plan) or "api_key", from `codex login status`. */
  method: "chatgpt" | "api_key" | null;
}

export function codexStatus(): CodexStatus {
  const version = spawnAgentSync("codex", ["--version"], { encoding: "utf8", timeout: 20_000 });
  if (version.error || version.status !== 0)
    return { installed: false, version: null, loggedIn: false, method: null };
  const status = spawnAgentSync("codex", ["login", "status"], {
    encoding: "utf8",
    timeout: 20_000,
  });
  const text = `${status.stdout}\n${status.stderr}`;
  const loggedIn = /logged in/i.test(text) && !/not logged in/i.test(text);
  return {
    installed: true,
    version: version.stdout.trim().split(/\s+/).at(-1) ?? null,
    loggedIn,
    method: !loggedIn ? null : /chatgpt/i.test(text) ? "chatgpt" : "api_key",
  };
}

/** The whole request as one prompt: codex exec takes a single message, its images attached with -i. */
export function codexPrompt(req: TextRequest, imageCount: number): string {
  const turns = req.messages.map((m) => {
    const text = m.content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    return `<${m.role}>\n${text}\n</${m.role}>`;
  });
  return [
    "Answer the last user message below directly in your reply. Do not run commands, read or edit files:",
    "everything you need is in this message and its attached images.",
    imageCount
      ? `${imageCount} image(s) are attached, in the order the messages mention them.`
      : "",
    "",
    "<instructions>",
    req.system,
    "</instructions>",
    "",
    turns.length === 1 ? (turns[0] ?? "") : turns.join("\n\n"),
  ]
    .filter((l) => l !== "")
    .join("\n");
}

interface CodexEvent {
  type?: string;
  item?: { type?: string; text?: string };
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
  message?: string;
  error?: { message?: string };
}

/** The reply, the token counts and the first error from codex exec's JSON lines. */
export function readCodexEvents(output: string): {
  text: string | null;
  usage: { input: number; cached: number; output: number };
  error: string | null;
} {
  let text: string | null = null;
  let error: string | null = null;
  const usage = { input: 0, cached: 0, output: 0 };
  for (const line of output.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let e: CodexEvent;
    try {
      e = JSON.parse(line) as CodexEvent;
    } catch {
      continue;
    }
    if (e.type === "item.completed" && e.item?.type === "agent_message" && e.item.text)
      text = e.item.text;
    else if (e.type === "turn.completed" && e.usage) {
      usage.input += e.usage.input_tokens ?? 0;
      usage.cached += e.usage.cached_input_tokens ?? 0;
      usage.output += e.usage.output_tokens ?? 0;
    } else if ((e.type === "error" || e.type === "turn.failed") && !error)
      error = e.message ?? e.error?.message ?? "Codex stopped with an error.";
  }
  return { text, usage, error };
}

export interface CodexOptions {
  /** Empty: the model set in Codex itself (~/.codex/config.toml). */
  model: string;
  effort: string;
}

export class CodexProvider implements TextProvider {
  readonly name = "codex";
  readonly model: string;
  readonly capabilities: Capabilities = {
    vision: true,
    structuredOutput: false,
    contextWindow: 400_000,
  };
  readonly billing = "plan" as const;
  private readonly effort: string;

  constructor(o: CodexOptions) {
    this.model = o.model;
    this.effort = o.effort;
  }

  preflight(): void {
    const s = codexStatus();
    if (!s.installed)
      throw new ProviderError(
        "Codex is not installed. Install it from developers.openai.com/codex/cli, or use an API key.",
        false,
      );
    if (!s.loggedIn)
      throw new ProviderError(
        "Codex is not signed in. Sign in from the settings (it runs `codex login`), then try again.",
        false,
      );
  }

  async complete(req: TextRequest): Promise<TextResponse> {
    const dir = mkdtempSync(join(tmpdir(), "mi-codex-"));
    try {
      const images: string[] = [];
      for (const m of req.messages)
        for (const p of m.content)
          if (p.type === "image") {
            const file = join(
              dir,
              `image-${images.length + 1}.${p.mediaType === "image/png" ? "png" : "jpg"}`,
            );
            writeFileSync(file, Buffer.from(p.base64, "base64"));
            images.push(file);
          }
      const args = [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "-c",
        `model_reasoning_effort="${this.effort === "max" ? "xhigh" : this.effort}"`,
        ...(this.model ? ["-m", this.model] : []),
        ...images.flatMap((f) => ["-i", f]),
      ];
      const out = await this.run(args, codexPrompt(req, images.length), dir);
      const r = readCodexEvents(out.stdout);
      if (r.error) {
        const unavailable = mentionsUnavailableModel(r.error);
        throw new ProviderError(
          `Codex: ${r.error}`,
          /rate|limit|overloaded|timeout/i.test(r.error),
          unavailable ? "model-unavailable" : undefined,
        );
      }
      if (out.code !== 0 || !r.text)
        throw new ProviderError(
          `Codex stopped without an answer (exit ${out.code}). ${out.stderr.split("\n").filter(Boolean).at(-1) ?? ""}`.trim(),
          true,
        );
      return {
        text: r.text,
        model: this.model || "codex",
        usage: {
          inputTokens: Math.max(0, r.usage.input - r.usage.cached),
          outputTokens: r.usage.output,
          cacheReadTokens: r.usage.cached,
        },
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private run(
    args: string[],
    prompt: string,
    cwd: string,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawnAgent("codex", args, { cwd });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
      proc.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
      // a scene can take minutes; a stuck run must still end
      const timer = setTimeout(() => proc.kill("SIGTERM"), 30 * 60_000);
      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(new ProviderError(`Could not start Codex: ${err.message}`, false));
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout, stderr });
      });
      proc.stdin.end(prompt);
    });
  }
}
