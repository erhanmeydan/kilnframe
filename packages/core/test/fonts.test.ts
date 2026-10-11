import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { missingGlyphs } from "../src/index.js";

const vendorFonts = join(import.meta.dirname, "../../../vendor/fonts");

function fontFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return fontFiles(path);
    return /\.(ttf|otf|woff2?)$/i.test(entry.name) ? [path] : [];
  });
}

describe("bundled fonts", () => {
  const files = fontFiles(vendorFonts);

  it("finds the bundled fonts", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s has every Turkish glyph", (file) => {
    expect(missingGlyphs(file, "İıŞşĞğÇçÖöÜü0123456789%")).toEqual([]);
  });
});
