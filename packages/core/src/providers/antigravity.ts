import { spawnAgent } from "./agent-binary.js";
import { runAgentProcess } from "./agent-run.js";
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
 *   (11 Nov 2026). One at a time was safe but slow (a three-scene job took 19 minutes against 11), so two go
 *   at once until the first capacity error, then one at a time for the rest of the process; such an error waits
 *   as long as it says and tries again.
 */

export interface AntigravityStatus {
  installed: boolean;
  version: string | null;
  loggedIn: boolean;
  /** `agy models` failed without saying the account is signed out (offline, a timeout, a Google error). */
  unreachable: boolean;
}

/** The message a job or the settings show when `agy models` could not reach Google. */
export const ANTIGRAVITY_UNREACHABLE =
  "Antigravity CLI could not reach Google. Check the internet connection and try again.";

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

/** Output of a short `agy` command, or null when it could not start or ran past the timeout. */
async function agy(
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; text: string } | null> {
  try {
    const r = await runAgentProcess(spawnAgent("agy", args, { cwd: tmpdir() }), "", {
      label: "Antigravity CLI",
      timeoutMs,
    });
    return { code: r.code, text: `${r.stdout}\n${r.stderr}` };
  } catch {
    return null;
  }
}

export interface AgyModelList {
  state: "ok" | "signed-out" | "unreachable";
  models: { id: string; name: string }[];
}

/** What `agy models` printed, read as signed in with models, signed out, or not reachable. */
export function readAgyModelsRun(run: { code: number; text: string } | null): AgyModelList {
  const models = run ? parseAgyModels(run.text) : [];
  if (run && run.code === 0 && models.length) return { state: "ok", models };
  // only an explicit sign-in message means signed out; anything else is a network or server trouble
  const auth =
    !!run &&
    /not authenticated|unauthenticated|not signed in|not logged in|log ?in|sign ?in/i.test(
      run.text,
    );
  return { state: auth ? "signed-out" : "unreachable", models: [] };
}

/**
 * `agy models` takes a second or more and goes over the network, and the settings, a job's check and the model
 * list all ask for it, so a good answer is kept a few minutes and calls under way are shared. A failure is not
 * kept: a sign-in in the terminal should show at the next look.
 */
const MODELS_TTL_MS = 3 * 60_000;
let modelsCache: { at: number; value: Promise<AgyModelList> } | null = null;

export function agyModels(now: () => number = Date.now): Promise<AgyModelList> {
  if (modelsCache && now() - modelsCache.at < MODELS_TTL_MS) return modelsCache.value;
  const value = agy(["models"], 10_000).then(readAgyModelsRun);
  const entry = { at: now(), value };
  modelsCache = entry;
  void value.then((r) => {
    if (r.state !== "ok" && modelsCache === entry) modelsCache = null;
  });
  return value;
}

/** Forgets the kept model list (tests, or after a sign-in or sign-out). */
export function forgetAgyModels(): void {
  modelsCache = null;
  lastStatus = null;
}

/** The last status read in this process, for the synchronous preflight. */
let lastStatus: AntigravityStatus | null = null;

export async function antigravityStatus(): Promise<AntigravityStatus> {
  const version = await agy(["--version"], 10_000);
  if (!version || version.code !== 0) {
    lastStatus = { installed: false, version: null, loggedIn: false, unreachable: false };
    return lastStatus;
  }
  const models = await agyModels();
  lastStatus = {
    installed: true,
    version:
      version.text
        .split("\n")
        .map((l) => l.trim())
        .find((l) => /^\d+\.\d+/.test(l)) ?? null,
    loggedIn: models.state === "ok",
    unreachable: models.state === "unreachable",
  };
  return lastStatus;
}

/** Throws the error an editor can act on when Antigravity cannot be used. */
function assertUsable(s: AntigravityStatus): void {
  if (!s.installed)
    throw new ProviderError(
      "Antigravity CLI is not installed. Install it from antigravity.google, or use an API key.",
      false,
    );
  if (s.unreachable) throw new ProviderError(ANTIGRAVITY_UNREACHABLE, true);
  if (!s.loggedIn)
    throw new ProviderError(
      "Antigravity CLI is not signed in. Run `agy` in a terminal and sign in with Google, then try again.",
      false,
    );
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

/** Runs at most `limit` tasks at once, in the order they came; the limit can be lowered later. */
export function requestSlots(initial: number) {
  let limit = initial;
  let active = 0;
  const waiting: (() => void)[] = [];
  const pump = () => {
    while (active < limit && waiting.length) {
      active++;
      waiting.shift()?.();
    }
  };
  return {
    get limit() {
      return limit;
    },
    lower(n: number) {
      limit = Math.max(1, Math.min(limit, n));
    },
    async run<T>(task: () => Promise<T>): Promise<T> {
      await new Promise<void>((r) => {
        waiting.push(r);
        pump();
      });
      try {
        return await task();
      } finally {
        active--;
        pump();
      }
    },
  };
}

/** Antigravity requests of this process (one job runs per process): two at once until Google says it is busy. */
const slots = requestSlots(2);
/** Capacity errors are tried again this many times. */
const CAPACITY_TRIES = 3;
/** Replaced in tests, so a capacity wait does not take seconds. */
export const antigravityTiming = {
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
};

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
  /** Installed and signed in, as the first request of this provider found. */
  private checked = false;

  constructor(o: AntigravityOptions) {
    this.model = o.model;
  }

  /**
   * Synchronous, so it only reads the status an earlier `antigravityStatus()` found (the companion reads it before
   * listing models); a job without one is checked by its first request instead.
   */
  preflight(): void {
    if (lastStatus) assertUsable(lastStatus);
  }

  async listModels(): Promise<ModelInfo[]> {
    const r = await agyModels();
    if (r.state === "unreachable") throw new ProviderError(ANTIGRAVITY_UNREACHABLE, true);
    return r.models
      .filter((m) => agyModelSeesImages(m.id))
      .map((m) => ({ id: m.id, displayName: m.name, contextWindow: null, vision: true }));
  }

  async complete(req: TextRequest): Promise<TextResponse> {
    if (!this.checked) {
      assertUsable(await antigravityStatus());
      this.checked = true;
    }
    for (let attempt = 1; ; attempt++) {
      try {
        return await slots.run(() => this.once(req));
      } catch (err) {
        if (!(err instanceof CapacityError) || attempt >= CAPACITY_TRIES) throw err;
        // the account takes fewer requests at once than we sent: one at a time from now on
        slots.lower(1);
        await antigravityTiming.sleep(err.waitMs);
      }
    }
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
      if (!r) {
        // a capacity error can come on stderr alone, without a result line
        const wait = capacityWaitMs(out.stderr);
        if (wait !== null)
          throw new CapacityError(
            `Your Google account is busy on this model: ${lastLine(out.stderr).slice(0, 300)} Wait a minute and try again, or use an API key.`,
            wait,
          );
        throw new ProviderError(
          `Antigravity stopped without an answer (exit ${out.code}). ${lastLine(out.stderr)}`.trim(),
          true,
        );
      }
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
            ? // Google's own text ends with a full stop already ("Resets in 146h42m32s.")
              `Google account usage limit reached: ${detail.replace(/[.\s]+$/, "")}. Wait for it to reset or use an API key.`
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
      // on Windows an agy child may still hold the folder; a leftover temp folder must not replace the answer
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // left for the system to clean
      }
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
  // a scene can take minutes; a stuck run must still end
  return runAgentProcess(spawnAgent("agy", args, { cwd }), input, {
    label: "Antigravity CLI",
    timeoutMs: 30 * 60_000,
  });
}
