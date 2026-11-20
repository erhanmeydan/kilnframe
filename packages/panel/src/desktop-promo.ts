import { lang, t, type Lang } from "./i18n";

/**
 * A small card at the bottom of the panel about Kilnframe Desktop, the paid desktop editor. It is drawn from
 * the panel's own text only: no request, no counting of views or clicks. The editor can close it (it stays
 * closed) or turn it off in the settings (it never shows).
 */

/**
 * Raised when the line says something new: an editor who closed an older one sees the new one once. One who
 * turned it off in the settings still never sees it.
 */
export const DESKTOP_PROMO_CAMPAIGN = 1;

/** Where "Take a look" goes, by panel language: the Kilnframe Desktop home page. */
export const DESKTOP_PROMO_URLS: Record<Lang, string> = {
  tr: "https://kilnframe.com/tr/",
  en: "https://kilnframe.com/",
};

/**
 * The card's height when it cannot be measured; app.ts sizes the scroll area above it from the card's own
 * height (UXP ignores flex-shrink), which grows when the description wraps in a narrow panel.
 */
export const DESKTOP_PROMO_HEIGHT = 58;

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

/**
 * The card's markup: Desktop's icon (a file inside the panel), its name and what it is, the link that opens
 * the page in the browser, and ×. The whole card opens the page too; × closes it.
 */
export function desktopPromoBar(language: Lang = lang()): string {
  const url = esc(desktopPromoUrl(language));
  const close = esc(t("promo.dismiss"));
  return `<div class="promo" role="note" data-act="open-url" data-val="${url}"><img class="promo-icon" src="icons/desktop@2x.png" width="32" height="32" alt=""><div class="promo-body"><div class="promo-head"><span class="promo-title">${esc(t("promo.title"))}</span><span class="link promo-link" data-act="open-url" data-val="${url}" role="link" tabindex="0">${esc(t("promo.link"))} ↗</span><span class="promo-x" data-act="promo-dismiss" role="button" tabindex="0" aria-label="${close}" title="${close}">×</span></div><div class="promo-text">${esc(t("promo.text"))}</div></div></div>`;
}
