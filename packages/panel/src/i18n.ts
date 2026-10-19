// Panel language: English by default, Turkish when Premiere runs in Turkish or the editor
// picks it. Every string lives in locales/<lang>.json, so a new language is a new file and an entry below.
import en from "./locales/en.json";
import tr from "./locales/tr.json";

export type Lang = "en" | "tr";
export type LangSetting = "auto" | Lang;
export type MessageKey = keyof typeof en;

const DICTS: Record<Lang, Record<string, string>> = { en, tr };
let current: Lang = "en";

export function setLang(lang: Lang): void {
  current = lang;
}

export function lang(): Lang {
  return current;
}

/** The setting wins; "auto" follows the editor's interface language ("tr_TR" -> Turkish), else English. */
export function pickLang(setting: LangSetting, uiLocale: string | null | undefined): Lang {
  if (setting !== "auto") return setting;
  return /^tr([_-]|$)/i.test(uiLocale ?? "") ? "tr" : "en";
}

/**
 * Looks a message up in the current language (English as the fallback) and fills {placeholders}. When `n` is
 * 1 and the message has a "<key>.one" form, that one is used: "1 section", not "1 sections".
 */
export function t(key: MessageKey, vars: Record<string, string | number> = {}): string {
  // the progress lines get their count from a regex, as text: "1" counts as one too
  const one = vars.n !== undefined && Number(vars.n) === 1 ? `${key}.one` : null;
  const text =
    (one && (DICTS[current][one] ?? DICTS.en[one])) ?? DICTS[current][key] ?? DICTS.en[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_, name: string) =>
    name in vars ? String(vars[name]) : `{${name}}`,
  );
}

/** A value given per language in a style's tokens.json, or a plain string from an older style. */
export function localized(value: string | Partial<Record<Lang, string>> | undefined): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value[current] ?? value.en ?? Object.values(value)[0] ?? "";
}
