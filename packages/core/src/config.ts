import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Model names live in config, never in code. */
export const DefaultsSchema = z.object({
  whisper: z.object({
    model: z.string().min(1),
    dtype: z.record(z.string(), z.string()),
    chunkLengthS: z.number().positive(),
  }),
  text: z.object({
    provider: z.enum(["auto", "claude-code", "anthropic", "openai-compatible"]),
    model: z.string().min(1),
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
    baseURL: z.string().url().optional(),
    /** Model for the style suggestion: a short call, a mid-size model is enough (benchmark, 7 Oct 2026). */
    suggestModel: z.string().min(1).optional(),
  }),
  /** Story mode narration: provider, model and default voice (config/speech.json lists them). */
  speech: z
    .object({
      provider: z.string().min(1),
      model: z.string().min(1),
      voice: z.string().min(1),
    })
    .default({ provider: "gemini", model: "gemini-3.8-flash-tts", voice: "Kore" }),
  /** Story mode music bed: provider and model (config/music.json) and the bed's loudness before ducking. */
  music: z
    .object({
      provider: z.string().min(1),
      model: z.string().min(1),
      lufs: z.number().max(-10).default(-24),
    })
    .default({ provider: "gemini", model: "lyria-3.5", lufs: -24 }),
  /** Reading text in the editor's screenshots. */
  ocr: z
    .object({
      languages: z.array(z.string().min(1)).min(1),
      /** Where the language files are downloaded from on first use; they are cached in modelsDir(). */
      dataUrl: z.string().url(),
    })
    .default({
      languages: ["tur", "eng"],
      dataUrl: "https://github.com/tesseract-ocr/tessdata_fast/raw/main",
    }),
});
export type Defaults = z.infer<typeof DefaultsSchema>;

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

export function loadDefaults(
  path = process.env.KILNFRAME_CONFIG ?? join(packageRoot, "config", "defaults.json"),
): Defaults {
  return DefaultsSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** Where downloaded models are cached. Overridable for the companion app and for tests. */
export function modelsDir(): string {
  return process.env.KILNFRAME_MODELS_DIR ?? join(homedir(), ".cache", "kilnframe", "models");
}

/** FFmpeg binary: the companion app sets this to its bundled copy, the CLI falls back to PATH. */
export function ffmpegPath(): string {
  return process.env.KILNFRAME_FFMPEG ?? "ffmpeg";
}
