import { parseArgs } from "node:util";
import { formatOf, outputSize, parseSize, type Size } from "../format.js";
import { parseFrameArg, type FrameInput } from "../frames.js";
import { parseRange } from "../media/audio.js";
import { formatFps, parseFps, type Fps } from "../fps.js";
import {
  OUTPUT_FORMATS,
  OUTPUT_MODES,
  type OutputFormat,
  type OutputMode,
} from "../schemas/plan.js";

export class CliError extends Error {}

export interface TranscribeArgs {
  command: "transcribe";
  audio: string;
  out: string;
  language: string | undefined;
}

export interface RunArgs {
  command: "run";
  audio: string;
  style: string;
  mode: OutputMode | "auto";
  format: OutputFormat;
  fps: Fps;
  /** The sequence size passed with --size. */
  sequence: Size;
  /** The rendered size for the chosen format. */
  output: Size;
  out: string;
  language: string | undefined;
  note: string | undefined;
  provider: string | undefined;
  model: string | undefined;
  effort: string | undefined;
  baseURL: string | undefined;
  transcript: string | undefined;
  range: { startS: number; endS: number } | undefined;
  stillsOnly: boolean;
  /** The editor's images, from repeated --image path[::note]. */
  images: { path: string; note?: string }[];
  /** Frames of the footage, from repeated --frame path@seconds. */
  frames: FrameInput[];
}

export interface RenderArgs {
  command: "render";
  plan: string;
  scenes: string;
  out: string;
  stillsOnly: boolean;
}

export interface ModelsArgs {
  command: "models";
  provider: string | undefined;
  baseURL: string | undefined;
}

export interface SuggestArgs {
  command: "suggest";
  /** A transcript of the whole video, or the audio to transcribe first. */
  transcript: string | undefined;
  audio: string | undefined;
  language: string | undefined;
  provider: string | undefined;
  model: string | undefined;
  effort: string | undefined;
  baseURL: string | undefined;
}

/** Your Own Style: make a style from a description and references, or change one with a note. */
export interface StyleCreateArgs {
  command: "style-create";
  describe: string;
  refs: { path: string; note?: string }[];
  /** Change this style of yours instead of making a new one. */
  revise: string | undefined;
  note: string | undefined;
  /** Skip the three-scene preview. */
  noPreview: boolean;
  out: string;
  provider: string | undefined;
  model: string | undefined;
  effort: string | undefined;
  baseURL: string | undefined;
}

/** Render the three sample scenes with a style again. */
export interface StylePreviewArgs {
  command: "style-preview";
  style: string;
  out: string;
  provider: string | undefined;
  model: string | undefined;
  effort: string | undefined;
  baseURL: string | undefined;
}

/** Story mode: write narration from a brief (or take a script) and read it aloud. */
export interface StoryArgs {
  command: "story";
  brief: string;
  /** A ready script (paragraphs separated by blank lines); skips writing. */
  script: string | undefined;
  durationS: number;
  language: string;
  tone: string | undefined;
  voice: string | undefined;
  speechModel: string | undefined;
  /** Write the story only, do not read it aloud. */
  noVoice: boolean;
  out: string;
  provider: string | undefined;
  model: string | undefined;
  effort: string | undefined;
  baseURL: string | undefined;
}

export type CliArgs =
  | StoryArgs
  | TranscribeArgs
  | RunArgs
  | RenderArgs
  | ModelsArgs
  | SuggestArgs
  | StyleCreateArgs
  | StylePreviewArgs
  | { command: "help" };

export const USAGE = `Usage:
  kilnframe run --audio <file> --style <name> --fps <rate> --size <WxH> --out <dir>
                    [--format landscape|portrait|square] [--mode fullscreen|overlay|auto]
                    [--language <code>] [--note <text>] [--stills-only] [--transcript <file>]
                    [--range <start-end seconds>] [--image <file>[::note]]... [--frame <file>@<seconds>]...
                    [--provider auto|claude-code|anthropic|openai-compatible] [--model <id>] [--effort <level>]
                    [--base-url <url>]
  kilnframe transcribe --audio <file> [--out <transcript.json>] [--language <code>]
  kilnframe render --plan <plan.json> --scenes <dir> --out <dir> [--stills-only]
  kilnframe models [--provider auto|claude-code|anthropic|openai-compatible] [--base-url <url>]
  kilnframe suggest (--transcript <file> | --audio <file>) [--language <code>]
                        [--provider ...] [--model <id>] [--effort <level>] [--base-url <url>]
  kilnframe style-create (--describe <text> | --ref <image>[::note]...) --out <dir>
                        [--revise <style> --note <text>] [--no-preview] [--provider ...] [--model <id>]
  kilnframe style-preview --style <name> --out <dir> [--provider ...] [--model <id>]
  kilnframe story (--brief <text> | --script <file>) --out <dir> [--duration <s>] [--language <code>]
                        [--tone <text>] [--voice <name>] [--speech-model <id>] [--no-voice] [--provider ...]

Examples:
  kilnframe run --audio parca.wav --style kil-lacivert --fps 30000/1001 --size 1920x1080 --out ./out
  kilnframe transcribe --audio parca.wav --language tr`;

function required(value: string | undefined, flag: string): string {
  if (value === undefined || value === "") throw new CliError(`Missing --${flag}.`);
  return value;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], flag: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new CliError(`Invalid --${flag} "${value}". Use one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

function wrap<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(err instanceof Error ? err.message : String(err));
  }
}

export function parseCliArgs(argv: string[], knownStyles: string[]): CliArgs {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h")
    return { command: "help" };

  const { values } = wrap(() =>
    parseArgs({
      args: rest,
      strict: true,
      options: {
        audio: { type: "string" },
        style: { type: "string" },
        mode: { type: "string" },
        format: { type: "string" },
        fps: { type: "string" },
        size: { type: "string" },
        out: { type: "string" },
        language: { type: "string" },
        note: { type: "string" },
        plan: { type: "string" },
        scenes: { type: "string" },
        "stills-only": { type: "boolean" },
        provider: { type: "string" },
        model: { type: "string" },
        effort: { type: "string" },
        "base-url": { type: "string" },
        transcript: { type: "string" },
        range: { type: "string" },
        image: { type: "string", multiple: true },
        frame: { type: "string", multiple: true },
        describe: { type: "string" },
        ref: { type: "string", multiple: true },
        revise: { type: "string" },
        "no-preview": { type: "boolean" },
        brief: { type: "string" },
        script: { type: "string" },
        duration: { type: "string" },
        tone: { type: "string" },
        voice: { type: "string" },
        "speech-model": { type: "string" },
        "no-voice": { type: "boolean" },
      },
    }),
  );

  if (command === "transcribe") {
    return {
      command,
      audio: required(values.audio, "audio"),
      out: values.out ?? "transcript.json",
      language: values.language,
    };
  }

  if (command === "suggest") {
    if (!values.transcript && !values.audio) throw new CliError("Missing --transcript or --audio.");
    return {
      command,
      transcript: values.transcript,
      audio: values.audio,
      language: values.language,
      provider: values.provider,
      model: values.model,
      effort: values.effort,
      baseURL: values["base-url"],
    };
  }

  const imageSpecs = (specs: string[] | undefined) =>
    (specs ?? []).map((spec) => {
      const [path = "", ...note] = spec.split("::");
      return note.length ? { path, note: note.join("::") } : { path };
    });

  if (command === "style-create") {
    if (!values.describe && !values.ref?.length && !values.revise)
      throw new CliError("Give --describe, --ref or --revise.");
    if (values.revise && !values.note) throw new CliError("--revise needs a --note.");
    return {
      command,
      describe: values.describe ?? "",
      refs: imageSpecs(values.ref),
      revise: values.revise,
      note: values.note,
      noPreview: values["no-preview"] ?? false,
      out: required(values.out, "out"),
      provider: values.provider,
      model: values.model,
      effort: values.effort,
      baseURL: values["base-url"],
    };
  }

  if (command === "story") {
    if (!values.brief && !values.script) throw new CliError("Give --brief or --script.");
    const durationS = values.duration ? Number(values.duration) : 60;
    if (!Number.isFinite(durationS) || durationS < 10 || durationS > 600)
      throw new CliError("--duration is seconds between 10 and 600.");
    return {
      command,
      brief: values.brief ?? "",
      script: values.script,
      durationS,
      language: values.language ?? "tr",
      tone: values.tone,
      voice: values.voice,
      speechModel: values["speech-model"],
      noVoice: values["no-voice"] ?? false,
      out: required(values.out, "out"),
      provider: values.provider,
      model: values.model,
      effort: values.effort,
      baseURL: values["base-url"],
    };
  }

  if (command === "style-preview") {
    return {
      command,
      style: required(values.style, "style"),
      out: required(values.out, "out"),
      provider: values.provider,
      model: values.model,
      effort: values.effort,
      baseURL: values["base-url"],
    };
  }

  if (command === "models") {
    return { command, provider: values.provider, baseURL: values["base-url"] };
  }

  if (command === "render") {
    return {
      command,
      plan: required(values.plan, "plan"),
      scenes: required(values.scenes, "scenes"),
      out: required(values.out, "out"),
      stillsOnly: values["stills-only"] ?? false,
    };
  }

  if (command === "run") {
    const style = required(values.style, "style");
    if (!knownStyles.includes(style)) {
      throw new CliError(
        `Unknown style "${style}". Available: ${knownStyles.join(", ") || "none found"}.`,
      );
    }
    const fps = wrap(() => parseFps(required(values.fps, "fps")));
    const sequence = wrap(() => parseSize(required(values.size, "size")));
    const format = values.format
      ? oneOf(values.format, OUTPUT_FORMATS, "format")
      : formatOf(sequence);
    return {
      command,
      audio: required(values.audio, "audio"),
      style,
      mode: values.mode
        ? oneOf(values.mode, [...OUTPUT_MODES, "auto"] as const, "mode")
        : "fullscreen",
      format,
      fps,
      sequence,
      output: outputSize(sequence, format),
      out: required(values.out, "out"),
      language: values.language,
      note: values.note,
      provider: values.provider,
      model: values.model,
      effort: values.effort,
      baseURL: values["base-url"],
      transcript: values.transcript,
      range: values.range ? wrap(() => parseRange(values.range as string)) : undefined,
      stillsOnly: values["stills-only"] ?? false,
      images: imageSpecs(values.image),
      frames: (values.frame ?? []).map((f) => wrap(() => parseFrameArg(f))),
    };
  }

  throw new CliError(`Unknown command "${command}".`);
}

/** One-line summary of a run, for logs. */
export function describeRun(args: RunArgs): string {
  return `${args.style}, ${args.mode}, ${args.format} ${args.output.width}x${args.output.height} @ ${formatFps(args.fps)} fps`;
}
