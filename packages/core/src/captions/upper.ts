const LETTER = /\p{L}/u;

/** Case fold that keeps the length and treats I, ı, İ and i as the same letter. */
function fold(text: string): string {
  return Array.from(text, (ch) => (/[Iıİi]/.test(ch) ? "i" : ch.toLowerCase())).join("");
}

/**
 * Changes the case of each word with change; a word that starts with a kept name (as a whole word,
 * before an apostrophe or punctuation) writes the name with named and only changes the rest.
 */
function recase(
  text: string,
  keep: string[],
  change: (s: string) => string,
  named: (entry: string) => string,
): string {
  const names = keep.filter(Boolean).map((entry) => ({ entry, folded: fold(entry) }));
  return text
    .split(/(\s+)/)
    .map((token) => {
      const folded = fold(token);
      const name = names.find(
        (n) => folded.startsWith(n.folded) && !LETTER.test(token.charAt(n.folded.length)),
      );
      if (!name) return change(token);
      return named(name.entry) + change(token.slice(name.folded.length));
    })
    .join("");
}

function locale(language: string): (s: string) => string {
  try {
    "".toLocaleLowerCase(language);
    return (s) => s.toLocaleLowerCase(language);
  } catch {
    return (s) => s.toLowerCase();
  }
}

/** Uppercases caption text. Turkish uses the dotted/dotless rule, except for names to keep as written. */
export function upperCase(text: string, language: string, keep: string[]): string {
  if (language !== "tr") return text.toUpperCase();
  return recase(
    text,
    keep,
    (s) => s.toLocaleUpperCase("tr"),
    (entry) => (/[İı]/.test(entry) ? entry.toLocaleUpperCase("tr") : entry.toUpperCase()),
  );
}

/** Lowercases caption text with the language's rules (Turkish I → ı); kept names stay as written. */
export function lowerCase(text: string, language: string, keep: string[]): string {
  return recase(text, keep, locale(language), (entry) => entry);
}
