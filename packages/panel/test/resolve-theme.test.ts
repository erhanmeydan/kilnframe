import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { missingGlyphs } from "../../core/src/fonts";
import { RESOLVE_COLOURS, STATUS_COLOURS, resolveTheme } from "../resolve/theme.mjs";

const page = readFileSync(join(__dirname, "..", "public", "index.html"), "utf8");
const colours = (html: string) => [
  ...new Set([...html.matchAll(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi)].map((m) => m[0].toLowerCase())),
];

describe("resolve theme", () => {
  it("has a Resolve colour for every colour of the panel, except the status colours it keeps", () => {
    const unknown = colours(page).filter(
      (c) => !(c in RESOLVE_COLOURS) && !STATUS_COLOURS.includes(c),
    );
    expect(unknown).toEqual([]);
  });

  it("swaps Premiere's greys and blues for Resolve's and keeps the status colours", () => {
    const themed = resolveTheme(page);
    for (const c of colours(themed))
      expect(Object.values(RESOLVE_COLOURS).includes(c) || STATUS_COLOURS.includes(c), c).toBe(
        true,
      );
    expect(themed).not.toMatch(/#5b8cff|#2d64c8|#232323/i);
    expect(themed).toContain("#e64c3c");
  });

  it("sets the panel in Open Sans, bundled beside the page", () => {
    const themed = resolveTheme(page);
    expect(themed).toMatch(/@font-face\s*{[^}]*"Open Sans"[^}]*fonts\/OpenSans-Variable\.ttf/);
    expect(themed).toMatch(/font-family:\s*"Open Sans"/);
  });

  it("bundles an Open Sans with every Turkish letter", () => {
    const font = join(__dirname, "..", "resolve", "fonts", "OpenSans-Variable.ttf");
    expect(missingGlyphs(font, "İıŞşĞğÇçÖöÜü0123456789%·")).toEqual([]);
  });

  it("leaves the Premiere page itself alone", () => {
    expect(page).toContain("#5b8cff");
    expect(page).not.toContain("Open Sans");
  });
});
