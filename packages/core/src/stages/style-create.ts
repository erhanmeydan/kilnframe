import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePalette, SYNTHS } from "@kilnframe/sfx";
import { z } from "zod";
import { prepareAssets, type AssetInput } from "../assets.js";
import { ffmpegPath } from "../config.js";
import { extractJson, loadPrompt } from "../prompts.js";
import { UsageMeter, type ChatMessage, type TextProvider } from "../providers/types.js";
import { PlanSchema, TECHNIQUES, type Plan } from "../schemas/plan.js";
import { TranscriptSchema } from "../schemas/transcript.js";
import { listStyles, loadStyle, stylesDir, userStylesDir, type LocalizedText } from "../styles.js";
import { composeScene, type ComposeContext, type ComposedScene } from "./compose.js";
import { renderPlan } from "./render.js";
import { validateAndRepair } from "./run.js";

/**
 * "Your Own Style": the editor describes a look in words,
 * shows 1 to 4 reference images, or both; the model writes the preset files (tokens.json, style.md,
 * sfx.json) into userStylesDir(), and previewStyle renders the three fixed sample scenes with it, so the
 * gallery shows what the tool really draws.
 */

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

/** Techniques a style can be asked about; the v2 ones are not offered yet. */
const STYLE_TECHNIQUES = TECHNIQUES.filter(
  (t) => !["lottie", "map", "shader", "footage", "catalog-block"].includes(t),
);

const SECTIONS = [
  "## Look",
  "## Type",
  "## Motion",
  "## How each technique looks in this style",
  "## User images",
  "## Sound palette",
  "## Forbidden",
] as const;

const SYNTH_NOTES: Record<string, string> = {
  thock: "low thud of an object settling; params: size (0.5 small to 2 heavy)",
  paper: "a paper sheet landing; no params",
  whoosh: "air moving past; params: dur (s), lo, hi (Hz band), peak (0-1)",
  pop: "soft rising pop; params: freq (Hz)",
  click: "quick ticks; params: count, gap (s)",
  shimmer: "gentle rising shimmer; params: dur (s)",
  chime: "settling chime; params: freq (Hz)",
  scratch: "pen, marker or chalk on a surface; params: dur (s), lo, hi (Hz band)",
};

const Localized = z.object({ en: z.string().min(1), tr: z.string().min(1) });

export const StyleDraftSchema = z.object({
  display_name: Localized,
  description: Localized,
  tokens: z.record(z.string(), z.unknown()),
  style_md: z.string().min(200),
  sfx: z.unknown(),
  notes: z.object({ en: z.string(), tr: z.string() }),
});
export type StyleDraft = z.infer<typeof StyleDraftSchema>;

interface CatalogFont {
  family: string;
  file: string;
  character: string;
  weights: string;
}

export function fontCatalog(): CatalogFont[] {
  return (
    JSON.parse(readFileSync(join(packageRoot, "config", "fonts.json"), "utf8")) as {
      fonts: CatalogFont[];
    }
  ).fonts;
}

function fontsIn(node: unknown, out: { family?: unknown; file?: unknown }[] = []) {
  if (Array.isArray(node)) for (const n of node) fontsIn(n, out);
  else if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if ("file" in o || "family" in o) out.push(o);
    else for (const v of Object.values(o)) fontsIn(v, out);
  }
  return out;
}

/** Problems with a draft that the model can fix: fonts, sections, sound palette, Turkish text. */
export function styleDraftProblems(draft: StyleDraft): string[] {
  const problems: string[] = [];
  const catalog = fontCatalog();
  const fonts = fontsIn(draft.tokens.fonts);
  if (!fonts.length) problems.push("tokens.fonts names no font.");
  for (const f of fonts) {
    const known = catalog.find((c) => c.family === f.family && c.file === f.file);
    if (!known)
      problems.push(
        `tokens.fonts uses ${JSON.stringify(f.family)} at ${JSON.stringify(f.file)}, which is not in the catalog; use a family and file exactly as listed.`,
      );
  }
  if (!draft.tokens.colors || typeof draft.tokens.colors !== "object")
    problems.push("tokens.colors is missing.");
  let at = -1;
  for (const section of SECTIONS) {
    const i = draft.style_md.indexOf(`\n${section}`);
    if (i < 0) problems.push(`style_md has no "${section}" section.`);
    else if (i < at) problems.push(`style_md: "${section}" is out of order.`);
    else at = i;
  }
  for (const t of STYLE_TECHNIQUES)
    if (!new RegExp(`^\\|\\s*${t}\\s*\\|`, "m").test(draft.style_md))
      problems.push(`style_md's technique table has no row for ${t}.`);
  try {
    const palette = parsePalette(draft.sfx, "sfx");
    for (const [name, s] of Object.entries(palette.sounds))
      if (!(s.synth in SYNTHS))
        problems.push(`sfx sound "${name}" uses unknown synth "${s.synth}".`);
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  }
  for (const text of [draft.display_name.tr, draft.description.tr, draft.notes.tr])
    if (/[–—]/.test(text)) problems.push(`Turkish text uses a dash: "${text}".`);
  return problems;
}

/** "Neon Gece" -> "neon-gece"; Turkish letters folded, unique among the styles that exist. */
export function styleSlug(name: string, taken: string[] = listStyles()): string {
  const base =
    name
      .toLocaleLowerCase("tr")
      .replace(/ı/g, "i")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "stil";
  let slug = base;
  for (let i = 2; taken.includes(slug); i++) slug = `${base}-${i}`;
  return slug;
}

function requestText(o: {
  description: string;
  references: AssetInput[];
  example: ReturnType<typeof loadStyle>;
  exampleSfx: string;
  previous?: { tokens: string; styleMd: string; sfx: string; note: string };
}): string {
  return [
    o.description.trim()
      ? `The editor describes the style:\n${o.description.trim()}`
      : "The editor gave no description; read the style from the reference images.",
    o.references.length
      ? `Reference images above (${o.references.length}), in order, with the editor's notes:\n${o.references.map((r, i) => `- ${i + 1}: ${r.note?.trim() || "(no note)"}`).join("\n")}`
      : "No reference images.",
    "",
    `Techniques the table must cover: ${STYLE_TECHNIQUES.join(", ")}`,
    "",
    "Font catalog (family, file, character, weights):",
    ...fontCatalog().map((f) => `- ${f.family} | ${f.file} | ${f.character} | ${f.weights}`),
    "",
    "Synths for the sound palette:",
    ...Object.keys(SYNTHS).map((s) => `- ${s}: ${SYNTH_NOTES[s] ?? ""}`),
    "",
    `Example preset (${o.example.name}), for the shape of the files only, not for its look:`,
    "tokens.json:",
    o.example.tokensJson,
    "style.md:",
    o.example.styleMd,
    "sfx.json:",
    o.exampleSfx,
    ...(o.previous
      ? [
          "",
          "Previous version of this style:",
          "tokens.json:",
          o.previous.tokens,
          "style.md:",
          o.previous.styleMd,
          "sfx.json:",
          o.previous.sfx,
          "",
          `The editor's note on it: ${o.previous.note}`,
        ]
      : []),
  ].join("\n");
}

export interface CreateStyleOptions {
  description: string;
  references: AssetInput[];
  provider: TextProvider;
  /** Scratch folder for the reference previews. */
  workDir: string;
  /** Change an existing style of the editor's instead of making a new one. */
  revise?: { name: string; note: string };
  /** The preset whose files show the model the shape to follow. */
  example?: string;
  maxAttempts?: number;
  onProgress?: (message: string) => void;
}

export interface CreatedStyle {
  name: string;
  dir: string;
  displayName: LocalizedText;
  notes: LocalizedText;
  usage: UsageMeter;
}

export async function createStyle(o: CreateStyleOptions): Promise<CreatedStyle> {
  if (!o.description.trim() && !o.references.length && !o.revise)
    throw new Error("Describe the style or add at least one reference image.");
  if (o.references.length > 4) throw new Error("Use at most 4 reference images.");
  const log = o.onProgress ?? (() => {});
  const usage = new UsageMeter();
  const provider = usage.wrap(o.provider);
  const refs = prepareAssets(o.references, o.workDir);
  const example = loadStyle(o.example ?? "flat-infografik", stylesDir());
  const exampleSfx = readFileSync(join(stylesDir(), example.name, "sfx.json"), "utf8");
  let previous: Parameters<typeof requestText>[0]["previous"];
  if (o.revise) {
    const dir = join(userStylesDir(), o.revise.name);
    if (!existsSync(join(dir, "style.md")))
      throw new Error(`There is no style of yours named ${o.revise.name}.`);
    previous = {
      tokens: readFileSync(join(dir, "tokens.json"), "utf8"),
      styleMd: readFileSync(join(dir, "style.md"), "utf8"),
      sfx: readFileSync(join(dir, "sfx.json"), "utf8"),
      note: o.revise.note,
    };
  }
  const messages: ChatMessage[] = [
    {
      role: "user",
      content: [
        ...refs.map((r) => ({
          type: "image" as const,
          mediaType: r.preview.mediaType,
          base64: r.preview.base64,
        })),
        {
          type: "text",
          text: requestText({
            description: o.description,
            references: o.references,
            example,
            exampleSfx,
            ...(previous ? { previous } : {}),
          }),
        },
      ],
    },
  ];
  const maxAttempts = o.maxAttempts ?? 3;
  let draft: StyleDraft | null = null;
  let problems: string[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(attempt === 1 ? "Writing the style" : `Writing the style (repair ${attempt - 1})`);
    const reply = await provider.complete({
      system: loadPrompt("style-create"),
      messages,
      maxTokens: 24_000,
      purpose: "style",
    });
    messages.push({ role: "assistant", content: [{ type: "text", text: reply.text }] });
    try {
      draft = StyleDraftSchema.parse(extractJson(reply.text));
      problems = styleDraftProblems(draft);
    } catch (err) {
      draft = null;
      problems =
        err instanceof z.ZodError
          ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`)
          : [err instanceof Error ? err.message : String(err)];
    }
    if (draft && !problems.length) break;
    messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text: `The style is not valid yet. Fix these problems and reply with the full JSON again:\n- ${problems.join("\n- ")}`,
        },
      ],
    });
  }
  if (!draft || problems.length)
    throw new Error(`The style could not be written:\n- ${problems.join("\n- ")}`);

  const name = o.revise?.name ?? styleSlug(draft.display_name.en);
  const dir = join(userStylesDir(), name);
  mkdirSync(dir, { recursive: true });
  // the tool owns these three keys
  const tokens = { ...draft.tokens };
  delete tokens.name;
  delete tokens.displayName;
  delete tokens.description;
  writeFileSync(
    join(dir, "tokens.json"),
    `${JSON.stringify({ name, displayName: draft.display_name, description: draft.description, ...tokens }, null, 2)}\n`,
  );
  writeFileSync(
    join(dir, "style.md"),
    `${draft.style_md.replace(/^#\s+.*$/m, `# ${name}`).trim()}\n`,
  );
  writeFileSync(join(dir, "sfx.json"), `${JSON.stringify(draft.sfx, null, 2)}\n`);
  if (refs.length) {
    // the references become PNGs the model sees until the first preview replaces them in the gallery
    mkdirSync(join(dir, "references"), { recursive: true });
    refs.forEach((r, i) => {
      const out = join(dir, "references", `ref-${i + 1}.png`);
      const res = spawnSync(ffmpegPath(), [
        "-v",
        "error",
        "-y",
        "-i",
        join(o.workDir, r.src),
        "-vf",
        "scale='min(1536,iw)':-2",
        out,
      ]);
      if (res.status !== 0) copyFileSync(join(o.workDir, r.src), out);
    });
  }
  writeFileSync(
    join(dir, "meta.json"),
    `${JSON.stringify(
      {
        created: new Date().toISOString(),
        description: o.description.trim() || null,
        revisions: o.revise ? [o.revise.note] : [],
        notes: draft.notes,
      },
      null,
      2,
    )}\n`,
  );
  log(`Style written: ${name}`);
  return { name, dir, displayName: draft.display_name, notes: draft.notes, usage };
}

/** The fixed sample plan and transcript (a metaphor, a number, a process), for any style. */
export function previewPlan(style: string): {
  plan: Plan;
  transcript: ReturnType<typeof TranscriptSchema.parse>;
} {
  const dir = join(packageRoot, "samples", "style-preview");
  const info = loadStyle(style);
  const raw = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8")) as Plan;
  const plan = PlanSchema.parse({
    ...raw,
    style,
    // a style that cannot do a technique shows the same idea as motion graphics
    scenes: raw.scenes.map((s) =>
      info.unsupported.includes(s.technique) ? { ...s, technique: "motion-2d" } : s,
    ),
  });
  const transcript = TranscriptSchema.parse(
    JSON.parse(readFileSync(join(dir, "transcript.json"), "utf8")),
  );
  return { plan, transcript };
}

const PREVIEW_NAMES = ["a-metafor.png", "b-veri.png", "c-surec.png"];

/**
 * Renders the three sample scenes with a style and keeps the stills as the style's gallery
 * (stills/a-metafor.png, b-veri.png, c-surec.png). Costs three scene compositions, no plan call.
 */
export async function previewStyle(o: {
  name: string;
  provider: TextProvider;
  outDir: string;
  maxRepairRounds?: number;
  onProgress?: (message: string) => void;
}): Promise<{ stills: string[]; usage: UsageMeter; repairRounds: number }> {
  const log = o.onProgress ?? (() => {});
  const usage = new UsageMeter();
  const { plan, transcript } = previewPlan(o.name);
  const ctx: ComposeContext = {
    provider: usage.wrap(o.provider),
    plan,
    transcript,
    style: loadStyle(o.name),
  };
  log(`Composing ${plan.scenes.length} sample scene(s)`);
  const composed = new Map<string, ComposedScene>();
  for (const c of await Promise.all(plan.scenes.map((s) => composeScene(ctx, s))))
    composed.set(c.id, c);
  const repairRounds = await validateAndRepair({
    ctx,
    plan,
    composed,
    outDir: o.outDir,
    maxRounds: o.maxRepairRounds ?? 3,
    log,
  });
  const render = await renderPlan({
    plan,
    scenes: Object.fromEntries([...composed.values()].map((c) => [c.id, c.html])),
    outDir: o.outDir,
    stillsOnly: true,
    prechecked: true,
    onProgress: log,
  });
  const home = join(userStylesDir(), o.name);
  if (existsSync(join(home, "style.md"))) {
    const stillsDir = join(home, "stills");
    mkdirSync(stillsDir, { recursive: true });
    for (const f of readdirSync(stillsDir))
      if (f.endsWith(".png")) rmSync(join(stillsDir, f), { force: true });
    render.stills.slice(0, 3).forEach((file, i) => {
      copyFileSync(file, join(stillsDir, PREVIEW_NAMES[i] as string));
    });
  }
  return { stills: render.stills, usage, repairRounds };
}
