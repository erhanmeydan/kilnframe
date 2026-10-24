import { loadPrompt } from "../prompts.js";
import type { TextProvider } from "../providers/types.js";
import { alignWords } from "./align.js";
import type { CaptionWord } from "./types.js";

/** Longest chunk sent to the model, in words. alignWords is quadratic, so it also runs per chunk. */
const CHUNK_WORDS = 800;
/** A reply whose word count differs from its source by more than this share counts as a rewrite. */
const MAX_COUNT_DRIFT = 0.3;

export interface CorrectOptions {
  provider: TextProvider;
  words: CaptionWord[];
  /** Language Whisper recognised, e.g. "tr" or "en". */
  language: string;
  /** Names the model must spell exactly as listed. */
  glossary: string[];
  /** Turkish only: "written" turns speech forms into written Turkish, "spoken" keeps them. */
  mode: "written" | "spoken";
  onProgress?: (message: string) => void;
}

export interface CorrectResult {
  words: CaptionWord[];
  corrected: boolean;
  error?: string;
}

/** The prompt file holds one `## heading` section per rule set. */
function section(source: string, heading: string): string {
  const start = source.indexOf(`## ${heading}\n`);
  if (start < 0) throw new Error(`Prompt section "${heading}" is missing.`);
  const bodyStart = start + heading.length + 4;
  const next = source.indexOf("\n## ", bodyStart);
  return source.slice(bodyStart, next < 0 ? undefined : next).trim();
}

function buildSystem(language: string, mode: "written" | "spoken", glossary: string[]): string {
  const source = loadPrompt("captions-correct");
  const parts = [section(source, "all languages")];
  if (language === "tr") {
    parts.push(section(source, mode === "spoken" ? "turkish spoken" : "turkish"));
  }
  const names = glossary.map((name) => name.trim()).filter(Boolean);
  if (names.length > 0) parts.push(`Names to spell exactly like this: ${names.join(", ")}.`);
  return parts.join("\n\n");
}

/** Splits into chunks of at most CHUNK_WORDS words, each ending at a sentence end when it can. */
function chunkWords(words: CaptionWord[]): CaptionWord[][] {
  const chunks: CaptionWord[][] = [];
  let from = 0;
  while (from < words.length) {
    let to = Math.min(from + CHUNK_WORDS, words.length);
    if (to < words.length) {
      for (let i = to - 1; i > from; i--) {
        if (/[.!?…]["')\]]*$/.test(words[i]!.text)) {
          to = i + 1;
          break;
        }
      }
    }
    chunks.push(words.slice(from, to));
    from = to;
  }
  return chunks;
}

/** Removes a code fence or a pair of quotes the model wrapped around its answer. */
function unwrap(reply: string): string {
  let text = reply.trim();
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text);
  if (fenced) text = fenced[1]!.trim();
  const quoted = /^(["“„«])([\s\S]*)(["”»])$/.exec(text);
  if (quoted) text = quoted[2]!.trim();
  return text;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Corrects the whole transcript with the editor's AI, chunk by chunk, and carries the Whisper
 * times over to the corrected words. A chunk that fails, or whose reply looks rewritten, keeps
 * its original words; the job never stops because of the correction.
 */
export async function correctTranscript(o: CorrectOptions): Promise<CorrectResult> {
  const chunks = chunkWords(o.words);
  if (chunks.length === 0) return { words: [], corrected: false };

  const system = buildSystem(o.language, o.mode, o.glossary);
  const result: CaptionWord[] = [];
  let failed = 0;
  let firstError = "";

  for (const [index, chunk] of chunks.entries()) {
    o.onProgress?.(`Correcting the text (${index + 1} of ${chunks.length})`);
    const source = chunk.map((w) => w.text).join(" ");
    try {
      const response = await o.provider.complete({
        system,
        messages: [{ role: "user", content: [{ type: "text", text: source }] }],
        maxTokens: chunk.length * 2 * 3,
        purpose: "captions-correct",
      });
      const text = unwrap(response.text);
      const count = wordCount(text);
      if (count === 0 || Math.abs(count - chunk.length) / chunk.length > MAX_COUNT_DRIFT) {
        throw new Error("The corrected text differs too much from the original.");
      }
      result.push(...alignWords(chunk, text));
    } catch (e) {
      failed++;
      if (!firstError) firstError = e instanceof Error ? e.message : String(e);
      result.push(...chunk);
    }
  }

  if (failed === 0) return { words: result, corrected: true };
  if (failed === chunks.length) return { words: result, corrected: false, error: firstError };
  return {
    words: result,
    corrected: true,
    error: `${failed} of ${chunks.length} parts kept the original text: ${firstError}`,
  };
}
