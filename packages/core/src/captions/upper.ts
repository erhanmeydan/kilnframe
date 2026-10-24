const LETTER = /\p{L}/u;

/** Uppercases caption text. Turkish uses the dotted/dotless rule, except for names to keep as written. */
export function upperCase(text: string, language: string, keep: string[]): string {
  if (language !== "tr") return text.toUpperCase();
  const names = keep.map((name) => name.toLocaleLowerCase("tr")).filter(Boolean);
  return text
    .split(/(\s+)/)
    .map((token) => {
      const lower = token.toLocaleLowerCase("tr");
      const name = names.find((n) => lower.startsWith(n) && !LETTER.test(token.charAt(n.length)));
      if (!name) return token.toLocaleUpperCase("tr");
      return (
        token.slice(0, name.length).toUpperCase() + token.slice(name.length).toLocaleUpperCase("tr")
      );
    })
    .join("");
}
