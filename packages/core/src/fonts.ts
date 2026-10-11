import * as fontkit from "fontkit";

/** Turkish letters every bundled or user font must contain. */
export const TURKISH_CHARS = "İıŞşĞğÇçÖöÜü";

/** Returns the characters from `chars` that the font file has no glyph for. */
export function missingGlyphs(fontPath: string, chars: string = TURKISH_CHARS): string[] {
  const font = fontkit.openSync(fontPath);
  if (!("hasGlyphForCodePoint" in font)) {
    throw new Error(`Font collections are not supported: ${fontPath}`);
  }
  return [...chars].filter((c) => !font.hasGlyphForCodePoint(c.codePointAt(0)!));
}
