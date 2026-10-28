import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** A style's still or reference image. */
export const STILL_FILE = /\.(png|jpe?g)$/i;

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

export function stylesDir(): string {
  return process.env.KILNFRAME_STYLES_DIR ?? join(repoRoot, "styles");
}

/** Styles the editor made ("Your Own Style"), kept for every project on this computer. */
export function userStylesDir(): string {
  return process.env.KILNFRAME_USER_STYLES_DIR ?? join(homedir(), ".kilnframe", "styles");
}

/** The folder that holds a style: the shipped presets first, then the editor's own styles. */
export function styleHome(name: string): string | null {
  for (const dir of [stylesDir(), userStylesDir()])
    if (existsSync(join(dir, name, "style.md"))) return dir;
  return null;
}

/**
 * Style presets are folders that contain a style.md and a tokens.json. Without a folder, the shipped presets
 * and the editor's own styles together (a name taken by a preset is never shadowed).
 */
export function listStyles(dir?: string): string[] {
  if (!dir)
    return [...new Set([...listStyles(stylesDir()), ...listStyles(userStylesDir())])].sort();
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter(
      (name) =>
        existsSync(join(dir, name, "style.md")) && existsSync(join(dir, name, "tokens.json")),
    )
    .sort();
}

export interface StyleFont {
  family: string;
  file: string;
  role: string;
  weight?: number;
}

/** Text per panel language. A plain string in an older or community style counts for every language. */
export type LocalizedText = Record<string, string>;

function localizedField(value: unknown, fallback: string): LocalizedText {
  if (typeof value === "string") return { en: value, tr: value };
  if (value && typeof value === "object") return value as LocalizedText;
  return { en: fallback, tr: fallback };
}

export interface StyleInfo {
  name: string;
  /** True for a style the editor made (it lives in userStylesDir()). */
  custom: boolean;
  /** Name shown to editors per panel language ({ en: "Paper Cut", tr: "Kağıt Kesik" }); falls back to the slug. */
  displayName: LocalizedText;
  /** One sentence per panel language for the style card. */
  description: LocalizedText;
  styleMd: string;
  tokensJson: string;
  stills: { name: string; base64: string; mediaType: "image/png" | "image/jpeg" }[];
  fonts: StyleFont[];
  /** Techniques the style's table marks "Not supported". */
  unsupported: string[];
  sounds: string[];
  /** Golden example scenes shipped with the style: styles/<style>/examples/<technique>.html */
  examples: Record<string, string>;
}

function collectFonts(node: unknown, role: string, out: StyleFont[]): void {
  if (Array.isArray(node)) {
    node.forEach((n, i) => collectFonts(n, `${role}[${i}]`, out));
    return;
  }
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (typeof o.family === "string" && typeof o.file === "string") {
      out.push({
        family: o.family,
        file: o.file,
        role,
        ...(typeof o.weight === "number" ? { weight: o.weight } : {}),
      });
      return;
    }
    for (const [k, v] of Object.entries(o)) collectFonts(v, role ? `${role}.${k}` : k, out);
  }
}

/** Techniques listed in style.md's table as "Not supported". */
export function unsupportedTechniques(styleMd: string): string[] {
  return [...styleMd.matchAll(/^\|\s*([a-z0-9-]+)\s*\|\s*Not supported/gim)].map(
    (m) => m[1] as string,
  );
}

export function loadStyle(name: string, dirIn?: string): StyleInfo {
  const dir = dirIn ?? styleHome(name) ?? stylesDir();
  const root = join(dir, name);
  if (!existsSync(join(root, "style.md"))) throw new Error(`Style "${name}" not found in ${dir}.`);
  const styleMd = readFileSync(join(root, "style.md"), "utf8");
  const tokensJson = readFileSync(join(root, "tokens.json"), "utf8");
  const fonts: StyleFont[] = [];
  collectFonts((JSON.parse(tokensJson) as { fonts?: unknown }).fonts, "", fonts);
  // the built-in styles ship JPEG stills (smaller app), an editor's own style has PNG ones
  const images = (folder: string) =>
    existsSync(folder)
      ? readdirSync(folder)
          .filter((f) => STILL_FILE.test(f))
          .sort()
          .map((f) => ({
            name: f,
            base64: readFileSync(join(folder, f)).toString("base64"),
            mediaType: (f.endsWith(".png") ? "image/png" : "image/jpeg") as
              "image/png" | "image/jpeg",
          }))
      : [];
  // an editor's style before its first preview has only the reference images it was made from
  const rendered = images(join(root, "stills"));
  const stills = rendered.length ? rendered : images(join(root, "references"));
  const sfxPath = join(root, "sfx.json");
  const sounds = existsSync(sfxPath)
    ? Object.keys(
        (JSON.parse(readFileSync(sfxPath, "utf8")) as { sounds: Record<string, unknown> }).sounds,
      )
    : [];
  const exDir = join(root, "examples");
  const examples = existsSync(exDir)
    ? Object.fromEntries(
        readdirSync(exDir)
          .filter((f) => f.endsWith(".html"))
          .map((f) => [f.replace(/\.html$/, ""), readFileSync(join(exDir, f), "utf8")]),
      )
    : {};
  return {
    name,
    displayName: localizedField(
      (JSON.parse(tokensJson) as { displayName?: unknown }).displayName,
      name,
    ),
    description: localizedField(
      (JSON.parse(tokensJson) as { description?: unknown }).description,
      "",
    ),
    custom: dir === userStylesDir(),
    styleMd,
    tokensJson,
    stills,
    fonts,
    unsupported: unsupportedTechniques(styleMd),
    sounds,
    examples,
  };
}
