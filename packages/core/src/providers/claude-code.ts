import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProviderError,
  mentionsUnavailableModel,
  type Capabilities,
  type ChatMessage,
  type ModelInfo,
  type TextProvider,
  type TextRequest,
  type TextResponse,
} from "./types.js";

/**
 * Uses the official Claude Code CLI the user installed and signed in to. The binary is
 * run unmodified in print mode; this code never reads or stores Claude credentials. Billing follows the
 * CLI's own login, so the user's Claude plan pays when they are signed in with claude.ai.
 */

export interface ClaudeCodeStatus {
  installed: boolean;
  version: string | null;
  loggedIn: boolean;
  /** "claude.ai" (plan) or "console" / "api_key" (API billing), as the CLI reports it. */
  authMethod: string | null;
  /** "pro", "max", ... when signed in with a plan. */
  subscription: string | null;
}

export function claudeBinary(): string {
  return process.env.KILNFRAME_CLAUDE ?? "claude";
}

/**
 * Variables a running Claude Code session gives the programs it starts. When Kilnframe was opened from such a
 * session (a terminal inside Claude Code), the CLI started for a job took itself for that session's child and
 * waited forever on the session's socket (9 Oct 2026). The editor's own settings (CLAUDE_CONFIG_DIR, a proxy
 * in ANTHROPIC_BASE_URL) are kept.
 */
export function withoutHostSession(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const key of Object.keys(out))
    if (
      key === "CLAUDECODE" ||
      key === "CLAUDE_PID" ||
      key === "AI_AGENT" ||
      key.startsWith("CLAUDE_AGENT_SDK_") ||
      (key.startsWith("CLAUDE_CODE_") && !KEEP.has(key))
    )
      delete out[key];
  return out;
}

/** Claude Code settings an editor may have set on purpose: a headless sign-in and the cloud to run on. */
const KEEP = new Set([
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
]);

/** Environment for the CLI: without our API key, so a signed-in plan is used instead of API billing. */
function cliEnv(usePlan: boolean): NodeJS.ProcessEnv {
  const env = withoutHostSession(process.env);
  if (usePlan) {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  return env;
}

/** Version and sign-in state. Only the fields the settings screen needs are kept (no e-mail or org). */
export function claudeCodeStatus(): ClaudeCodeStatus {
  const version = spawnSync(claudeBinary(), ["--version"], { encoding: "utf8", timeout: 20_000 });
  if (version.error || version.status !== 0) {
    return {
      installed: false,
      version: null,
      loggedIn: false,
      authMethod: null,
      subscription: null,
    };
  }
  const status = spawnSync(claudeBinary(), ["auth", "status"], {
    encoding: "utf8",
    timeout: 20_000,
    env: cliEnv(true),
  });
  let parsed: { loggedIn?: boolean; authMethod?: string; subscriptionType?: string } = {};
  try {
    parsed = JSON.parse(status.stdout) as typeof parsed;
  } catch {
    // older CLIs print text; treat as unknown
  }
  return {
    installed: true,
    version: (version.stdout.trim().split(/\s+/)[0] ?? null) || null,
    loggedIn: parsed.loggedIn === true,
    authMethod: parsed.authMethod ?? null,
    subscription: parsed.subscriptionType ?? null,
  };
}

/** Folds a conversation into one prompt: claude -p takes a single message per call. */
export function conversationPrompt(messages: ChatMessage[], imagePaths: string[][]): string {
  const blocks = messages.map((m, i) => {
    const text = m.content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    const images = imagePaths[i] ?? [];
    const imageNote = images.length
      ? `Reference images for this message (open each with the Read tool before answering):\n${images.join("\n")}\n\n`
      : "";
    return { role: m.role, body: `${imageNote}${text}` };
  });
  if (blocks.length === 1) return blocks[0]?.body ?? "";
  const history = blocks
    .slice(0, -1)
    .map((b) => `<${b.role}>\n${b.body}\n</${b.role}>`)
    .join("\n\n");
  return `This continues an earlier exchange in the same task:\n\n${history}\n\nNow answer this message:\n\n${blocks.at(-1)?.body ?? ""}`;
}

interface CliResult {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  stop_reason?: string;
  api_error_status?: number | null;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  modelUsage?: Record<string, unknown>;
}

export interface ClaudeCodeOptions {
  model: string;
  effort: string;
  /** true: bill the signed-in plan (strip API keys from the CLI's environment). */
  usePlan?: boolean;
}

export class ClaudeCodeProvider implements TextProvider {
  readonly name = "claude-code";
  readonly model: string;
  readonly capabilities: Capabilities = {
    vision: true,
    structuredOutput: false,
    contextWindow: 200_000,
  };
  readonly billing: "plan" | "api";
  private readonly effort: string;
  private readonly usePlan: boolean;

  constructor(o: ClaudeCodeOptions) {
    this.model = o.model;
    this.effort = o.effort;
    this.usePlan = o.usePlan ?? true;
    this.billing = this.usePlan ? "plan" : "api";
  }

  preflight(): void {
    const s = claudeCodeStatus();
    if (!s.installed) {
      throw new ProviderError(
        "Claude Code is not installed. Install it from claude.com/code, or use an API key.",
        false,
      );
    }
    if (!s.loggedIn) {
      throw new ProviderError(
        "Claude Code is not signed in. Run `claude auth login` in a terminal, then try again.",
        false,
      );
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    // The CLI has no model list; it accepts the current model IDs and the aliases opus, sonnet, haiku.
    return ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"].map((id) => ({
      id,
      displayName: id,
      contextWindow: null,
      vision: true,
    }));
  }

  async complete(req: TextRequest): Promise<TextResponse> {
    const work = mkdtempSync(join(tmpdir(), "mi-claude-"));
    try {
      const imageDir = join(work, "images");
      const imagePaths = req.messages.map((m, i) =>
        m.content.flatMap((p, j) => {
          if (p.type !== "image") return [];
          mkdirSync(imageDir, { recursive: true });
          const file = join(imageDir, `m${i}-${j}.${p.mediaType === "image/png" ? "png" : "jpg"}`);
          writeFileSync(file, Buffer.from(p.base64, "base64"));
          return [file];
        }),
      );
      const hasImages = imagePaths.some((list) => list.length > 0);
      const args = [
        "-p",
        "--output-format",
        "json",
        "--model",
        this.model,
        "--effort",
        this.effort,
        "--tools",
        hasImages ? "Read" : "",
        "--no-session-persistence",
        "--strict-mcp-config",
        "--system-prompt",
        req.system,
      ];
      if (hasImages) args.push("--allowedTools", "Read", "--add-dir", imageDir);
      const prompt = conversationPrompt(req.messages, imagePaths);
      const { stdout, stderr, code } = await run(
        claudeBinary(),
        args,
        prompt,
        work,
        cliEnv(this.usePlan),
      );
      let parsed: CliResult;
      try {
        parsed = JSON.parse(stdout) as CliResult;
      } catch {
        throw new ProviderError(
          `Claude Code did not return a result for ${req.purpose} (exit ${code}). ${stderr.trim().slice(0, 300)}`,
          true,
        );
      }
      if (parsed.is_error || parsed.subtype !== "success") {
        const detail = (parsed.result ?? stderr).trim().slice(0, 300);
        const limit = /limit|quota|usage/i.test(detail);
        if (!limit && mentionsUnavailableModel(detail)) {
          throw new ProviderError(
            `Claude Code cannot use the model "${this.model}": ${detail}`,
            false,
            "model-unavailable",
          );
        }
        throw new ProviderError(
          limit
            ? `Claude plan usage limit reached: ${detail}. Wait for the limit to reset or use an API key.`
            : `Claude Code failed on ${req.purpose}: ${detail}`,
          !limit,
        );
      }
      if (parsed.stop_reason === "refusal") {
        throw new ProviderError(
          "The model declined this request. Try rewording the note or the content.",
          false,
        );
      }
      const u = parsed.usage ?? {};
      return {
        text: parsed.result ?? "",
        model: Object.keys(parsed.modelUsage ?? {})[0] ?? this.model,
        usage: {
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          ...(parsed.total_cost_usd !== undefined ? { listPriceUsd: parsed.total_cost_usd } : {}),
        },
      };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
}

function run(
  bin: string,
  args: string[],
  input: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    proc.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    proc.on("error", (err) =>
      reject(new ProviderError(`Could not start Claude Code (${bin}): ${err.message}`, false)),
    );
    proc.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    proc.stdin.end(input);
  });
}
