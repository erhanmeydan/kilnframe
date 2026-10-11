import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { vendorDir } from "../src/project/assemble.js";
import {
  fontCatalog,
  previewPlan,
  styleDraftProblems,
  styleSlug,
  type StyleDraft,
} from "../src/stages/style-create.js";
import { stylesDir } from "../src/styles.js";

function draftFrom(style: string): StyleDraft {
  const dir = join(stylesDir(), style);
  const tokens = JSON.parse(readFileSync(join(dir, "tokens.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const { displayName, description } = tokens;
  delete tokens.name;
  delete tokens.displayName;
  delete tokens.description;
  return {
    display_name: displayName as StyleDraft["display_name"],
    description: description as StyleDraft["description"],
    tokens,
    style_md: readFileSync(join(dir, "style.md"), "utf8"),
    sfx: JSON.parse(readFileSync(join(dir, "sfx.json"), "utf8")),
    notes: { en: "", tr: "" },
  };
}

describe("your own style", () => {
  it("offers exactly the vendored fonts", () => {
    const catalog = fontCatalog();
    for (const f of catalog)
      expect(existsSync(join(vendorDir(), f.file.replace(/^vendor\//, ""))), f.file).toBe(true);
    const vendored = readdirSync(join(vendorDir(), "fonts"), { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".ttf"))
      // readdir gives Windows' separators there; the catalog's paths are URLs in the HTML
      .map((f) => `vendor/fonts/${f.replaceAll("\\", "/")}`);
    expect(catalog.map((f) => f.file).sort()).toEqual(vendored.sort());
  });

  it("accepts a well formed style and names what is wrong with a broken one", () => {
    const good = draftFrom("gazete-editoryal");
    const missing = styleDraftProblems(good).filter((p) => !p.includes("technique table"));
    expect(missing).toEqual([]);

    const bad: StyleDraft = {
      ...good,
      tokens: {
        ...good.tokens,
        fonts: { display: { family: "Comic Sans", file: "vendor/fonts/comic.ttf" } },
      },
      style_md: good.style_md.replace("## User images", "## Pictures"),
      sfx: {
        version: 1,
        master_db: -5,
        pan: 0.2,
        room: { enabled: true, db: -50 },
        sounds: { x: { synth: "laser" } },
      },
      notes: { en: "", tr: "Kağıt dokusu — kodla" },
    };
    const problems = styleDraftProblems(bad).join("\n");
    expect(problems).toMatch(/Comic Sans.*not in the catalog/);
    expect(problems).toMatch(/no "## User images" section/);
    expect(problems).toMatch(/unknown synth "laser"/);
    expect(problems).toMatch(/uses a dash/);
  });

  it("makes a folder name from the display name, Turkish letters folded, never a taken one", () => {
    expect(styleSlug("Neon Gece Şehri", [])).toBe("neon-gece-sehri");
    expect(styleSlug("İnce Çizgi", [])).toBe("ince-cizgi");
    expect(styleSlug("Kil Lacivert")).toBe("kil-lacivert-2");
  });

  it("previews any style with the same three scenes, swapping techniques it cannot do", () => {
    const { plan, transcript } = previewPlan("gazete-editoryal");
    expect(plan.scenes.map((s) => s.technique)).toEqual(["motion-2d", "data-viz", "diagram"]);
    expect(plan.style).toBe("gazete-editoryal");
    expect(transcript.words.length).toBeGreaterThan(15);
    const words = transcript.words.map((w) => w.text).join(" ");
    expect(words).toContain("yetmiş");
  });
});
