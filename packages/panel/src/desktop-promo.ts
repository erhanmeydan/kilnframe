import { lang, t, type Lang } from "./i18n";

/**
 * A quiet line at the bottom of the panel about Kilnframe Desktop, the paid desktop editor. It is drawn from
 * the panel's own text only: no request, no counting of views or clicks. The editor can close it (it stays
 * closed) or turn it off in the settings (it never shows).
 */

/**
 * Raised when the line says something new: an editor who closed an older one sees the new one once. One who
 * turned it off in the settings still never sees it.
 */
export const DESKTOP_PROMO_CAMPAIGN = 1;

/** Where "Take a look" goes, by panel language. Until Desktop is out, the pages' sign-up for its news. */
export const DESKTOP_PROMO_URLS: Record<Lang, string> = {
  tr: "https://kilnframe.com/tr/#haber",
  en: "https://kilnframe.com/#notify",
};

/** The line's height; the scroll area above it is sized by app.ts (UXP ignores flex-shrink). */
export const DESKTOP_PROMO_HEIGHT = 26;

export interface DesktopPromoSettings {
  /** The settings' switch; shown unless turned off. */
  desktopPromo?: "on" | "off";
  /** The campaign the editor closed with ×. */
  desktopPromoDismissed?: number;
}

export function desktopPromoUrl(language: Lang = lang()): string {
  return DESKTOP_PROMO_URLS[language];
}

/** Whether the line shows: not turned off, and not closed for this campaign. */
export function showsDesktopPromo(
  s: DesktopPromoSettings,
  campaign: number = DESKTOP_PROMO_CAMPAIGN,
): boolean {
  return s.desktopPromo !== "off" && (s.desktopPromoDismissed ?? 0) < campaign;
}

/** The settings after ×: closed for this campaign. */
export function dismissDesktopPromo<T extends DesktopPromoSettings>(
  s: T,
  campaign: number = DESKTOP_PROMO_CAMPAIGN,
): T {
  return { ...s, desktopPromoDismissed: campaign };
}

/** The settings after the switch: Show also brings back a line closed with ×. */
export function setDesktopPromo<T extends DesktopPromoSettings>(s: T, value: "on" | "off"): T {
  if (value === "off") return { ...s, desktopPromo: "off" };
  return { ...s, desktopPromo: "on", desktopPromoDismissed: undefined };
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The line's markup: the text, the link that opens the page in the browser, and ×. */
export function desktopPromoBar(language: Lang = lang()): string {
  const text = t("promo.text");
  const close = t("promo.dismiss");
  return `<div class="promo" role="note"><span class="promo-text" title="${esc(text)}">${esc(text)}</span><span class="link promo-link" data-act="open-url" data-val="${esc(desktopPromoUrl(language))}" role="link" tabindex="0">${esc(t("promo.link"))} ↗</span><span class="promo-x" data-act="promo-dismiss" role="button" tabindex="0" aria-label="${esc(close)}" title="${esc(close)}">×</span></div>`;
}
