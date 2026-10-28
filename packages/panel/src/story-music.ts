import { t } from "./i18n";

/**
 * The line under a finished story when its music could not be made: the narration was placed without it.
 * A Gemini key on the free tier gets no Lyria requests at all, so that case says how to turn billing on.
 */
export function storyMusicNote(musicError: string | null | undefined): string {
  if (!musicError) return "";
  return /free[ _]tier/i.test(musicError) ? t("story.musicFreeTier") : t("story.musicFailed");
}
