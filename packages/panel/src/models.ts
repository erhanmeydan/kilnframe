// How the panel names models that have no name of their own in the provider list.

/** A model id as a name: "grok-4.7" is Grok 4.7, "gpt-6.1-sol" GPT 6.1 Sol, "MiniMax-M3" MiniMax M3. */
export function prettyModel(id: string): string {
  const name = id.split("/").pop() ?? id;
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) =>
      /^(gpt|glm)$/i.test(w)
        ? w.toUpperCase()
        : /^[a-z]/.test(w)
          ? w[0]!.toUpperCase() + w.slice(1)
          : w,
    )
    .join(" ");
}

/** A model a local server (LM Studio) or OpenRouter reported, as the companion passes it on. */
export interface ServedModel {
  id: string;
  displayName: string;
  contextWindow: number | null;
  vision: boolean | null;
  /** LM Studio: loaded now, with this context, and whether its thinking can be turned off. */
  loaded?: boolean;
  loadedContext?: number | null;
  reasons?: boolean;
}

/** A context length as the picker shows it: 262144 is "262K". */
function contextK(n: number | null | undefined): string {
  return n ? `${Math.round(n / 1000)}K` : "";
}

/**
 * LM Studio's models that read images for the picker: the loaded ones first with the context they were
 * loaded with ("Loaded · 38K"), then the others with their max context.
 */
export function lmStudioRows(
  served: ServedModel[],
  loadedLabel: string,
): { id: string; info: string; loaded: boolean }[] {
  const seeing = served.filter((m) => m.vision);
  return [
    ...seeing
      .filter((m) => m.loaded)
      .map((m) => ({
        id: m.id,
        info: `${loadedLabel} · ${contextK(m.loadedContext ?? m.contextWindow)}`.replace(
          / · $/,
          "",
        ),
        loaded: true,
      })),
    ...seeing
      .filter((m) => !m.loaded)
      .map((m) => ({ id: m.id, info: contextK(m.contextWindow), loaded: false })),
  ];
}

/** The LM Studio model used when the editor chose none: a loaded one that reads images, else any. */
export function lmStudioDefault(served: ServedModel[]): string {
  return served.find((m) => m.vision && m.loaded)?.id ?? served.find((m) => m.vision)?.id ?? "";
}
