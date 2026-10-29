// Story mode's "own text" path: the editor pastes a text written elsewhere and it goes straight to the
// narration screen; no model writes or changes it.

/** The story pipeline voices at most this long. */
export const OWN_MAX_S = 600;

/** A scene of a pasted text without blank lines stays under this many words. */
const SCENE_WORDS = 60;

/** Narration pace measured on Gemini TTS (packages/core/src/stages/story.ts). */
export function storySeconds(text: string, language: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return words / (language === "tr" ? 1.5 : 2.2);
}

/**
 * The text as scenes: the editor's own paragraphs (blank lines) when there are any, otherwise a long text is
 * cut at sentence ends into scenes of at most SCENE_WORDS words.
 */
export function ownParagraphs(text: string): string {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length > 1) return paragraphs.join("\n\n");
  const all = text.trim().replace(/\s+/g, " ");
  const sentences = all.match(/[^.!?…]+[.!?…]+["'”’)]*\s*|[^.!?…]+$/g) ?? [all];
  const scenes: string[] = [];
  let current = "";
  for (const s of sentences.map((x) => x.trim()).filter(Boolean)) {
    const words = (current ? `${current} ${s}` : s).split(" ").length;
    if (current && words > SCENE_WORDS) {
      scenes.push(current);
      current = s;
    } else current = current ? `${current} ${s}` : s;
  }
  if (current) scenes.push(current);
  return scenes.join("\n\n");
}

/** The story's title: its first sentence, at most 60 characters. */
export function ownTitle(text: string): string {
  const first = (text.trim().split(/[.!?…\n]/)[0] ?? "").trim();
  return first.length > 60 ? `${first.slice(0, 59).trimEnd()}…` : first;
}

/** Words, the narration's estimated length, and whether it is over the limit. */
export function ownSummary(
  text: string,
  language: string,
): { words: number; seconds: number; tooLong: boolean } {
  const words = text.split(/\s+/).filter(Boolean).length;
  const seconds = Math.round(storySeconds(text, language));
  return { words, seconds, tooLong: seconds > OWN_MAX_S };
}
