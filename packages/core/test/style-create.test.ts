import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { vendorDir } from "../src/project/assemble.js";
import { ffmpegPath } from "../src/config.js";
import type { TextRequest, TextProvider } from "../src/providers/types.js";
import {
  createStyle,
  fontCatalog,
  previewPlan,
  styleDraftProblems,
  styleSlug,
  withoutRoomTone,
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

  it("writes a style's sounds with no room tone under them, whatever the draft asked", () => {
    const sfx = { version: 1, master_db: -6, pan: 0.2, room: { enabled: true, db: -22 }, sounds: {} };
    expect(withoutRoomTone(sfx)).toEqual({ ...sfx, room: { enabled: false, db: -22 } });
    expect(sfx.room.enabled).toBe(true);
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

  it("takes up to twelve references and a reference video's measured motion, which the model is told", async () => {
    const work = mkdtempSync(join(tmpdir(), "kf-style-refs-"));
    const home = mkdtempSync(join(tmpdir(), "kf-user-styles-"));
    const before = process.env.KILNFRAME_USER_STYLES_DIR;
    process.env.KILNFRAME_USER_STYLES_DIR = home;
    try {
      const refs = [0, 1, 2, 3, 4, 5].map((i) => {
        const file = join(work, `ref-${i}.png`);
        const r = spawnSync(ffmpegPath(), ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=0x${(i * 30).toString(16).padStart(2, "0")}4060:s=64x36`, "-frames:v", "1", file]);
        expect(r.status).toBe(0);
        return { path: file, note: i ? `frame ${i} of the video` : "a poster" };
      });
      const draft = draftFrom("gazete-editoryal");
      // the rows this older guide leaves out, added so the draft is whole
      const rows = styleDraftProblems(draft)
        .map((p) => /no row for ([a-z0-9-]+)/.exec(p)?.[1])
        .filter(Boolean)
        .map((t) => `| ${t} | Not supported: test |`)
        .join("\n");
      const tableAt = draft.style_md.indexOf("\n## User images");
      const whole = { ...draft, style_md: `${draft.style_md.slice(0, tableAt)}\n${rows}\n${draft.style_md.slice(tableAt)}`, display_name: { en: "Test Video Look", tr: "Deneme Video Görünümü" } };
      expect(styleDraftProblems(whole)).toEqual([]);
      const asked: TextRequest[] = [];
      const provider: TextProvider = {
        name: "test",
        model: "test",
        complete: async (request) => {
          asked.push(request);
          return { text: JSON.stringify(whole), model: "test", usage: { inputTokens: 0, outputTokens: 0 } } as never;
        },
      } as TextProvider;
      const made = await createStyle({ description: "", references: refs, motion: "Cuts per minute: 42\nAverage shot: 1.4 s", provider, workDir: work });
      const content = asked[0]?.messages[0]?.content ?? [];
      expect(content.filter((c) => c.type === "image")).toHaveLength(6);
      const text = content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
      expect(text).toContain("Cuts per minute: 42");
      expect(text).toContain("- 2: frame 1 of the video");
      expect(made.name).toBe("test-video-look");
      expect(readdirSync(join(home, made.name, "references"))).toHaveLength(6);
      const many = Array.from({ length: 13 }, () => refs[0] as { path: string });
      await expect(createStyle({ description: "", references: many, provider, workDir: work })).rejects.toThrow(/at most 12/);
    } finally {
      if (before === undefined) delete process.env.KILNFRAME_USER_STYLES_DIR;
      else process.env.KILNFRAME_USER_STYLES_DIR = before;
      rmSync(work, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
