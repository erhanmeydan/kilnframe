import { z } from "zod";
import { extractJson, loadPrompt } from "../prompts.js";
import type { ChatMessage, TextProvider } from "../providers/types.js";
import type { Transcript } from "../schemas/transcript.js";
import type { StyleInfo } from "../styles.js";

/**
 * Style suggestion: one style is used for every insert of a video, so the model reads the
 * whole video's transcript and recommends the 2 or 3 styles that fit it best. The editor makes the choice.
 */

export const StyleSuggestionsSchema = z.object({
  suggestions: z
    .array(z.object({ style: z.string().min(1), reason: z.string().min(1) }))
    .min(1)
    .max(3),
});
export type StyleSuggestions = z.infer<typeof StyleSuggestionsSchema>;

/** The style's own one-paragraph description from style.md, without the reference still list. */
export function styleSummary(style: StyleInfo): string {
  const intro =
    style.styleMd
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .find((p) => p && !p.startsWith("#")) ?? "";
  return intro
    .replace(/\s*Reference stills:[^\n]*(\n[^\n]*)?$/s, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Keeps the transcript small for long videos: under the limit it is sent whole, otherwise evenly spaced
 * excerpts from beginning to end, so topic and tone of the whole video still come through.
 */
export function transcriptDigest(text: string, maxChars = 12_000, parts = 6): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  const size = Math.floor(maxChars / parts);
  const step = (clean.length - size) / (parts - 1);
  const excerpts: string[] = [];
  for (let i = 0; i < parts; i++) {
    const at = Math.round(i * step);
    excerpts.push(clean.slice(at, at + size).trim());
  }
  return excerpts.join(" [...] ");
}

export function suggestRequestText(
  transcript: Transcript,
  styles: StyleInfo[],
  reasonLanguage: string,
): string {
  const list = styles
    .map(
      (s) =>
        `- ${s.name}: ${styleSummary(s)}${s.unsupported.length ? ` Unsupported techniques: ${s.unsupported.join(", ")}.` : ""}`,
    )
    .join("\n");
  return [
    `Video length: ${Math.round(transcript.duration_s)} s. Spoken language: ${transcript.language ?? "unknown"}.`,
    `Write the reasons in this language: ${reasonLanguage}.`,
    "",
    "Available styles:",
    list,
    "",
    "Transcript of the video:",
    transcriptDigest(transcript.text),
  ].join("\n");
}

/** Problems with a reply: unknown style names or the same style twice. */
export function suggestionProblems(s: StyleSuggestions, styleNames: string[]): string[] {
  const p: string[] = [];
  const seen = new Set<string>();
  for (const { style } of s.suggestions) {
    if (!styleNames.includes(style))
      p.push(`"${style}" is not an available style; use one of: ${styleNames.join(", ")}.`);
    if (seen.has(style)) p.push(`"${style}" is suggested twice.`);
    seen.add(style);
  }
  return p;
}

export interface SuggestOptions {
  provider: TextProvider;
  transcript: Transcript;
  styles: StyleInfo[];
  /** Language of the reasons shown to the editor, for example "tr" or "en". */
  reasonLanguage?: string;
  maxAttempts?: number;
}

export async function suggestStyles(o: SuggestOptions): Promise<StyleSuggestions> {
  const names = o.styles.map((s) => s.name);
  const messages: ChatMessage[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: suggestRequestText(o.transcript, o.styles, o.reasonLanguage ?? "tr"),
        },
      ],
    },
  ];
  const maxAttempts = o.maxAttempts ?? 2;
  let problems: string[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const reply = await o.provider.complete({
      system: loadPrompt("suggest"),
      messages,
      // reasoning models (DeepSeek V4 Pro) count their thinking against this limit
      maxTokens: 8_000,
      purpose: "suggest styles",
    });
    messages.push({ role: "assistant", content: [{ type: "text", text: reply.text }] });
    try {
      const parsed = StyleSuggestionsSchema.parse(extractJson(reply.text));
      problems = suggestionProblems(parsed, names);
      if (problems.length === 0) return parsed;
    } catch (err) {
      problems = [err instanceof Error ? err.message : String(err)];
    }
    messages.push({
      role: "user",
      content: [
        { type: "text", text: `Fix these problems and reply again:\n- ${problems.join("\n- ")}` },
      ],
    });
  }
  throw new Error(`The style suggestion failed: ${problems.join(" ")}`);
}
