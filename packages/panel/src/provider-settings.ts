/** What the panel knows of a preset provider, as the companion lists it. */
export interface PresetInfo {
  id: string;
  models: string[];
  requires: string[];
}

/** Providers whose model list is not the preset's own: any model the server or the editor names. */
const OPEN_MODEL_LISTS = new Set([
  "custom",
  "openrouter",
  "lmstudio",
  "ollama",
  "codex",
  "antigravity",
]);

/** Only the custom endpoint and presets that need their own address show an address field. */
export function offersAddress(id: string, entry: PresetInfo | undefined): boolean {
  return id === "custom" || (entry?.requires.length ?? 0) > 0;
}

/** A preset's chosen model, or its default when the preset does not offer the chosen one. */
export function presetModel(
  id: string,
  chosen: string | undefined,
  entry: PresetInfo | undefined,
): string {
  if (!entry || OPEN_MODEL_LISTS.has(id)) return chosen ?? "";
  return chosen && entry.models.includes(chosen) ? chosen : (entry.models[0] ?? "");
}

/**
 * Drops saved values a preset cannot have: an address where no field offers one (an older panel copied the
 * custom endpoint's address onto the next provider, sending that provider's key to it), and a model the
 * preset does not offer.
 */
export function cleanProviderSettings<
  T extends { baseURLs: Record<string, string>; models: Record<string, string> },
>(settings: T, list: PresetInfo[]): T {
  const byId = new Map(list.map((p) => [p.id, p]));
  const baseURLs = Object.fromEntries(
    Object.entries(settings.baseURLs).filter(([id]) => offersAddress(id, byId.get(id))),
  );
  const models = Object.fromEntries(
    Object.entries(settings.models).filter(([id, m]) => {
      const entry = byId.get(id);
      return !entry || OPEN_MODEL_LISTS.has(id) || entry.models.includes(m);
    }),
  );
  return { ...settings, baseURLs, models };
}
