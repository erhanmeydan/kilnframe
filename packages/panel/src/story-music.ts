import { t } from "./i18n";

/**
 * The line under a finished story when its music could not be made: the narration was placed without it.
 * A Gemini key on the free tier gets no Lyria requests at all, so that case says how to turn billing on;
 * an ElevenLabs key without the music permission, or a plan without music, says what to change.
 */
export function storyMusicNote(musicError: string | null | undefined): string {
  if (!musicError) return "";
  if (/free[ _]tier/i.test(musicError)) return t("story.musicFreeTier");
  // an ElevenLabs key without the music permission, or a plan without music
  if (/ElevenLabs key is missing a permission/.test(musicError))
    return t("story.musicElevenPermission");
  if (/ElevenLabs plan does not include/.test(musicError)) return t("story.musicElevenPlan");
  return t("story.musicFailed");
}
