const LETTER = /\p{L}/u;

/** Case fold that keeps the length and treats I, ı, İ and i as the same letter. */
function fold(text: string): string {
  return Array.from(text, (ch) => (/[Iıİi]/.test(ch) ? "i" : ch.toLowerCase())).join("");
}

/** Uppercases caption text. Turkish uses the dotted/dotless rule, except for names to keep as written. */
export function upperCase(text: string, language: string, keep: string[]): string {
  if (language !== "tr") return text.toUpperCase();
  const names = keep.filter(Boolean).map((entry) => ({ entry, folded: fold(entry) }));
  return text
    .split(/(\s+)/)
    .map((token) => {
      const folded = fold(token);
      const name = names.find(
        (n) => folded.startsWith(n.folded) && !LETTER.test(token.charAt(n.folded.length)),
      );
      if (!name) return token.toLocaleUpperCase("tr");
      const head = /[İı]/.test(name.entry)
        ? name.entry.toLocaleUpperCase("tr")
        : name.entry.toUpperCase();
      return head + token.slice(name.folded.length).toLocaleUpperCase("tr");
    })
    .join("");
}
