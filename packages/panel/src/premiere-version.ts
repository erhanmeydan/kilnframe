import { t } from "./i18n";

/** The oldest Premiere whose UXP API has everything the panel calls (the manifest's minVersion too). */
export const MIN_PREMIERE = "26.2";

/**
 * Calls a Premiere API method, or says plainly that this Premiere is too old for it: an older Premiere lacks
 * methods such as SequenceSettings.getVideoFrameRate and would otherwise fail with "is not a function".
 */
export async function premiereCall<T>(obj: object, method: string, ...args: unknown[]): Promise<T> {
  const fn = (obj as Record<string, unknown>)[method];
  if (typeof fn !== "function") throw new Error(t("premiere.tooOld", { version: MIN_PREMIERE }));
  return (await (fn as (...a: unknown[]) => unknown).apply(obj, args)) as T;
}
