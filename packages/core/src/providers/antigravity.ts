import { spawnAgent, spawnAgentSync } from "./agent-binary.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProviderError,
  mentionsUnavailableModel,
  type Capabilities,
  type ModelInfo,
  type TextProvider,
  type TextRequest,
  type TextResponse,
} from "./types.js";

/**
 * Uses Google's official Antigravity CLI (`agy`) the user installed and signed in to with their Google account,
 * the way the Claude Code and Codex providers work. The binary runs unmodified in print mode; this code never
 * reads or stores Google credentials, and the editor's own Google account or Gemini subscription pays.
 *
 * Checked on Antigravity CLI 1.5.5 (10 Nov 2026):
 * - A prompt on the command line is limited by the OS (about 32 000 characters on Windows), so the prompt goes on
 *   stdin as one stream-json message: `{"event":"user","message":{"role":"user","content":[{"type":"text",...}]}}`
 *   with `--input-format stream-json --output-format stream-json -p=` (an empty -p value; `-p` alone takes the
 *   next flag as its prompt). The last line of type "result" carries status, response, error and usage.
 * - Content blocks are text only, so images are written to a folder the agent may read (`--add-dir`) and the
 *   prompt names them; its file tool opens them as pictures (a test frame's blue top and printed word were read).
 * - `--mode plan` keeps the agent from editing files or running commands.
 * - `agy models` prints one "id<TAB>name" line per model the account may use; the effort is part of the id
 *   (gemini-3.8-flash-high), and `--effort` is refused for some models, so it is never passed.
 * - A free Google account takes few requests at once: three scenes composed together ended the first panel job
 *   with "RESOURCE_EXHAUSTED (code 429): You have exhausted your capacity on this model. Resets in 0s."
 *   (11 Nov 2026). So the requests go one at a time, and such an error waits as long as it says and tries again.
 */

export interface AntigravityStatus {
  installed: boolean;
  version: string | null;
  loggedIn: boolean;
}

/** "id<TAB>name" lines from `agy models`; the first line ("Fetching available models...") has no tab. */
export function parseAgyModels(output: string): { id: string; name: string }[] {
  return output
    .split("\n")
    .map((l) => l.trim().split("\t"))
    .filter((p): p is [string, string] => p.length >= 2 && !!p[0] && !!p[1])
    .map(([id, name]) => ({ id: id.trim(), name: name.trim() }));
}

/**
 * Models that read pictures: Gemini and Claude do, GPT-OSS does not. Kilnframe offers only models that see the
 * frames, so an unknown family stays out until it is checked.
 */
export function agyModelSeesImages(id: string): boolean {
  return /^(gemini|claude)-/i.test(id);
}

function agyModels(): { code: number; text: string } {
  const r = spawnAgentSync("agy", ["models"], { encoding: "utf8", timeout: 60_000, cwd: tmpdir() });
  return { code: r.error ? 1 : (r.status ?? 1), text: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

export function antigravityStatus(): AntigravityStatus {
  const version = spawnAgentSync("agy", ["--version"], { encoding: "utf8", timeout: 20_000 });
  if (version.error || version.status !== 0)
    return { installed: false, version: null, loggedIn: false };
  const models = agyModels();
  return {
    installed: true,
    version:
      version.stdout
        .split("\n")
        .map((l) => l.trim())
        .find((l) => /^\d+\.\d+/.test(l)) ?? null,
    loggedIn:
      models.code === 0 &&
      parseAgyModels(models.text).length > 0 &&
      !/not authenticated|not signed in|log ?in|sign ?in/i.test(models.text.split("\n")[0] ?? ""),
  };
}

/** The whole request as one message: system text first, then the turns, then the pictures to open. */
export function antigravityPrompt(req: TextRequest, images: string[]): string {
  const turns = req.messages.map((m) => {
    const text = m.content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    return `<${m.role}>\n${text}\n</${m.role}>`;
  });
  return [
    "Answer the last user message below directly in your reply. Do not run commands, search, or edit files:",
    "everything you need is in this message",
    images.length
      ? `and in these reference images, in the order the messages mention them. Open each image file before answering:\n${images.join("\n")}`
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

interface AgyResult {
  status?: string;
  response?: string;
  error?: string;
  finished_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    thinking_tokens?: number;
    cache_read_tokens?: number;
  };
}

/** The result line of a stream-json run, or null when the run ended without one. */
export function readAgyResult(output: string): AgyResult | null {
  let result: AgyResult | null = null;
  for (const line of output.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const e = JSON.parse(line) as { event?: string; result?: AgyResult };
      if (e.event === "result" && e.result) result = e.result;
    } catch {
      // a line that is not an event
    }
  }
  return result;
}

/** How long a capacity error asks to wait, or null when it is not one or the wait is hours (a daily quota). */
export function capacityWaitMs(detail: string): number | null {
  if (!/RESOURCE_EXHAUSTED|exhausted your capacity/i.test(detail)) return null;
  const m = /Resets in ([0-9hms.]+)/i.exec(detail);
  if (!m) return 30_000;
  const text = m[1] ?? "";
  if (/\d+h/.test(text)) return null;
  const minutes = Number(/(\d+)m/.exec(text)?.[1] ?? 0);
  const seconds = Number(/(\d+(?:\.\d+)?)s/.exec(text)?.[1] ?? 0);
  const ms = (minutes * 60 + seconds) * 1000;
  // more than ten minutes is not worth holding a job for
  return ms > 10 * 60_000 ? null : Math.ceil(ms) + 5_000;
}

/** A queue that runs one task at a time, in the order they came. */
export function oneAtATime(): <T>(task: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>) => {
    const next = chain.then(task, task);
    chain = next.catch(() => undefined);
    return next;
  };
}

/** Every Antigravity request of this process waits for the one before it (one job runs per process). */
const queue = oneAtATime();
/** Capacity errors are tried again this many times. */
const CAPACITY_TRIES = 3;

class CapacityError extends ProviderError {
  constructor(
    message: string,
    readonly waitMs: number,
  ) {
    super(message, true);
  }
}

export interface AntigravityOptions {
  /** Empty: the model the account uses by default. */
  model: string;
}

export class AntigravityProvider implements TextProvider {
  readonly name = "antigravity";
  readonly model: string;
  readonly capabilities: Capabilities = {
    vision: true,
    structuredOutput: false,
    contextWindow: 1_000_000,
  };
  readonly billing = "plan" as const;

  constructor(o: AntigravityOptions) {
    this.model = o.model;
  }

  preflight(): void {
    const s = antigravityStatus();
    if (!s.installed)
      throw new ProviderError(
        "Antigravity CLI is not installed. Install it from antigravity.google, or use an API key.",
        false,
      );
    if (!s.loggedIn)
      throw new ProviderError(
        "Antigravity CLI is not signed in. Run `agy` in a terminal and sign in with Google, then try again.",
        false,
      );
  }

  async listModels(): Promise<ModelInfo[]> {
    const r = agyModels();
    return parseAgyModels(r.text)
      .filter((m) => agyModelSeesImages(m.id))
      .map((m) => ({ id: m.id, displayName: m.name, contextWindow: null, vision: true }));
  }

  complete(req: TextRequest): Promise<TextResponse> {
    return queue(async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await this.once(req);
        } catch (err) {
          if (!(err instanceof CapacityError) || attempt >= CAPACITY_TRIES) throw err;
          await new Promise((r) => setTimeout(r, err.waitMs));
        }
      }
    });
  }

  private async once(req: TextRequest): Promise<TextResponse> {
    const dir = mkdtempSync(join(tmpdir(), "mi-agy-"));
    try {
      const imageDir = join(dir, "images");
      const images: string[] = [];
      for (const m of req.messages)
        for (const p of m.content)
          if (p.type === "image") {
            // a folder of its own that the agent may read, the only one it is given
            if (!images.length) mkdirSync(imageDir, { recursive: true });
            const file = join(
              imageDir,
              `image-${images.length + 1}.${p.mediaType === "image/png" ? "png" : "jpg"}`,
            );
            writeFileSync(file, Buffer.from(p.base64, "base64"));
            images.push(file);
          }
      const args = [
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--mode",
        "plan",
        "--disable-slash-commands",
        ...(this.model ? ["--model", this.model] : []),
        ...(images.length ? ["--add-dir", imageDir] : []),
        "-p=",
      ];
      const message = JSON.stringify({
        event: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: antigravityPrompt(req, images) }],
        },
      });
      const out = await run(args, `${message}\n`, dir);
      const r = readAgyResult(out.stdout);
      if (!r)
        throw new ProviderError(
          `Antigravity stopped without an answer (exit ${out.code}). ${lastLine(out.stderr)}`.trim(),
          true,
        );
      if (r.status !== "SUCCESS" || r.finished_reason) {
        const detail = (r.error ?? lastLine(out.stderr) ?? "").trim().slice(0, 300);
        const wait = capacityWaitMs(detail);
        if (wait !== null)
          throw new CapacityError(
            `Your Google account is busy on this model: ${detail} Wait a minute and try again, or use an API key.`,
            wait,
          );
        const limit = /quota|limit|exhausted|credits?/i.test(detail);
        if (!limit && mentionsUnavailableModel(detail))
          throw new ProviderError(
            `Antigravity cannot use the model "${this.model}": ${detail}`,
            false,
            "model-unavailable",
          );
        throw new ProviderError(
          limit
            ? `Google account usage limit reached: ${detail}. Wait for it to reset or use an API key.`
            : `Antigravity failed on ${req.purpose}: ${detail || `the run ended (${r.finished_reason ?? r.status})`}`,
          !limit,
        );
      }
      const u = r.usage ?? {};
      return {
        text: r.response ?? "",
        model: this.model || "antigravity",
        usage: {
          inputTokens: Math.max(0, (u.input_tokens ?? 0) - (u.cache_read_tokens ?? 0)),
          outputTokens: u.output_tokens ?? 0,
          cacheReadTokens: u.cache_read_tokens ?? 0,
        },
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

function lastLine(text: string): string {
  return (
    text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("ERROR: logging before"))
      .at(-1) ?? ""
  );
}

function run(
  args: string[],
  input: string,
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawnAgent("agy", args, { cwd });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    proc.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    // a scene can take minutes; a stuck run must still end
    const timer = setTimeout(() => proc.kill("SIGTERM"), 30 * 60_000);
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new ProviderError(`Could not start Antigravity CLI: ${err.message}`, false));
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    proc.stdin.end(input);
  });
}
