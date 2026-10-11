import { z } from "zod";
import { extractJson, loadPrompt } from "../prompts.js";
import type { ChatMessage, TextProvider } from "../providers/types.js";

/**
 * Story mode, step one: the narration is written from the
 * editor's brief, then shown for editing and approval before anything is read aloud.
 */

export const StorySchema = z.object({
  title: z.string().min(1),
  voice_style: z.string().min(1),
  paragraphs: z.array(z.string().min(1)).min(1),
});
export type Story = z.infer<typeof StorySchema>;

/**
 * Narration pace in words per second, measured on Gemini TTS with a calm documentary direction
 * (2026-10-07: 100 Turkish words in 67.6 s of speech, 1.48 per second). Turkish words are longer.
 */
export function wordsPerSecond(language: string): number {
  return language.startsWith("tr") ? 1.5 : language.startsWith("en") ? 2.2 : 1.9;
}

export function storyText(story: Pick<Story, "paragraphs">): string {
  return story.paragraphs.map((p) => p.trim()).join("\n\n");
}

export function storyProblems(story: Story, targetWords: number): string[] {
  const problems: string[] = [];
  const words = storyText(story).split(/\s+/).filter(Boolean).length;
  if (words < targetWords * 0.85 || words > targetWords * 1.15)
    problems.push(
      `The narration has ${words} words; the target is about ${targetWords} (within 15%).`,
    );
  if (/[–—]|\s-\s/.test(storyText(story)))
    problems.push("The narration uses dashes; use commas or full stops.");
  return problems;
}

export interface WriteStoryOptions {
  provider: TextProvider;
  brief: string;
  durationS: number;
  language: string;
  tone?: string | undefined;
  /** A previous version and the editor's note on it. */
  revise?: { story: Story; note: string } | undefined;
  maxAttempts?: number;
  onProgress?: (message: string) => void;
}

export async function writeStory(o: WriteStoryOptions): Promise<Story> {
  if (!o.brief.trim() && !o.revise) throw new Error("Write what the story should be about.");
  const target = Math.round(o.durationS * wordsPerSecond(o.language));
  const request = [
    `Brief: ${o.brief.trim() || "(see the previous version)"}`,
    `Language: ${o.language}`,
    `Target duration: ${o.durationS} s, about ${target} words`,
    o.tone?.trim() ? `Tone: ${o.tone.trim()}` : null,
    ...(o.revise
      ? [
          "",
          "Previous version:",
          JSON.stringify(o.revise.story, null, 2),
          `The editor's note on it: ${o.revise.note}`,
        ]
      : []),
  ]
    .filter((l) => l !== null)
    .join("\n");
  const messages: ChatMessage[] = [{ role: "user", content: [{ type: "text", text: request }] }];
  const maxAttempts = o.maxAttempts ?? 3;
  let problems: string[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    o.onProgress?.(
      attempt === 1 ? "Writing the story" : `Writing the story (repair ${attempt - 1})`,
    );
    const reply = await o.provider.complete({
      system: loadPrompt("story"),
      messages,
      maxTokens: 8000,
      purpose: "story",
    });
    messages.push({ role: "assistant", content: [{ type: "text", text: reply.text }] });
    try {
      const story = StorySchema.parse(extractJson(reply.text));
      problems = storyProblems(story, target);
      if (!problems.length) return story;
    } catch (err) {
      problems =
        err instanceof z.ZodError
          ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`)
          : [err instanceof Error ? err.message : String(err)];
    }
    messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text: `Not right yet. Fix these and reply with the full JSON again:\n- ${problems.join("\n- ")}`,
        },
      ],
    });
  }
  throw new Error(`The story could not be written:\n- ${problems.join("\n- ")}`);
}
