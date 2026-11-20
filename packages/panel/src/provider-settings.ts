/** What the panel knows of a preset provider, as the companion lists it. */
export interface PresetInfo {
  id: string;
  models: string[];
  requires: string[];
}

/** Providers whose model list is not the preset's own: any model the server or the editor names. */
const OPEN_MODEL_LISTS = new Set(["custom", "openrouter", "lmstudio", "ollama", "codex"]);

/** Claude models the list no longer offers, moved to the one that took their place. */
const CLAUDE_MODEL_SUCCESSORS: Record<string, string> = { "claude-fable-5-1": "claude-fable-5-2" };

/**
 * The saved Claude model, or the one that took its place. It lives here, not in app.ts: the panel reads its
 * settings while app.ts is still starting, before a table declared further down that file exists (the
 * settings then fell back to the defaults on every start).
 */
export function claudeModelSuccessor(model: string): string {
  return CLAUDE_MODEL_SUCCESSORS[model] ?? model;
}

/**
 * Providers the panel once offered and no longer does. A saved choice of one goes back to Automatic, and its
 * kept model is forgotten: Antigravity CLI was left out when Google said its consumer plans do not cover
 * other apps running it.
 */
const REMOVED_PROVIDERS = new Set(["antigravity"]);

/** The saved settings without a provider the panel no longer offers. */
export function withoutRemovedProviders<
  T extends { provider: string; models: Record<string, string> },
>(settings: T): T {
  const models = Object.fromEntries(
    Object.entries(settings.models).filter(([id]) => !REMOVED_PROVIDERS.has(id)),
  );
  const provider = REMOVED_PROVIDERS.has(settings.provider) ? "auto" : settings.provider;
  return { ...settings, provider, models };
}

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
