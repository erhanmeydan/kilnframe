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
