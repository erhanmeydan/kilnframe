import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { z } from "zod";
import { ffmpegPath, type Defaults } from "./config.js";
import { closeOcr, ensureOcrData, readText, type OcrLine } from "./ocr.js";
import { AssetInfoSchema, type AssetInfo } from "./schemas/plan.js";

/**
 * The editor's own images (logo, product shots, screenshots, illustrations). They are copied into the job folder, measured, and a small
 * preview goes to the model so the plan can decide where each image belongs. The animation uses the copy.
 */

export const ASSET_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"] as const;

/** One image as the editor added it. */
export interface AssetInput {
  path: string;
  /** Optional words from the editor: "product logo", "the app's home screen". */
  note?: string | undefined;
}

export interface PreparedAsset extends AssetInfo {
  /** Small preview for the model: JPEG, or PNG when the image is transparent. */
  preview: { mediaType: "image/png" | "image/jpeg"; base64: string };
  /** Text read in the image with positions; filled by readAssetText, empty for pictures without text. */
  lines?: OcrLine[];
}

/**
 * Reads the text in each image (screenshots mostly) and saves it as asset-text/<id>.json, so the plan can
 * mark an exact line. Downloads the reader's language files on first use.
 */
export async function readAssetText(
  assets: PreparedAsset[],
  outDir: string,
  ocr: Defaults["ocr"],
  onProgress?: (message: string) => void,
): Promise<void> {
  if (!assets.length) return;
  await ensureOcrData(ocr, onProgress);
  onProgress?.("Reading text in the images");
  mkdirSync(join(outDir, "asset-text"), { recursive: true });
  try {
    for (const a of assets) {
      a.lines = await readText(join(outDir, a.src), a.width, ocr);
      writeFileSync(
        join(outDir, "asset-text", `${a.id}.json`),
        `${JSON.stringify(a.lines, null, 2)}\n`,
      );
    }
  } finally {
    await closeOcr();
  }
}

/** The lines read in an image earlier, for a recompose. */
export function readAssetLines(outDir: string, id: string): OcrLine[] {
  const file = join(outDir, "asset-text", `${id}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as OcrLine[]) : [];
}

/** Width, height and alpha from ffmpeg's stream line ("Video: png, rgba(pc), 1536x1024"). */
export function parseImageStream(ffmpegLog: string): {
  width: number;
  height: number;
  hasAlpha: boolean;
} {
  const line = /Stream #\d+:\d+.*?: Video: (.+)/.exec(ffmpegLog)?.[1];
  if (!line) throw new Error("not an image ffmpeg can read");
  const size = /\b(\d{2,5})x(\d{2,5})\b/.exec(line);
  if (!size) throw new Error("image size not found");
  // pixel formats with an alpha channel: rgba, argb, bgra, abgr, ya8, ya16, yuva420p, gbrap, pal8 (png palette)
  const hasAlpha = /\b(rgba|argb|bgra|abgr|ya8|ya16\w*|yuva\w*|gbrap\w*|rgba64\w*|pal8)\b/.test(
    line,
  );
  return { width: Number(size[1]), height: Number(size[2]), hasAlpha };
}

function probe(file: string): { width: number; height: number; hasAlpha: boolean } {
  const r = spawnSync(ffmpegPath(), ["-hide_banner", "-i", file], { encoding: "utf8" });
  return parseImageStream(`${r.stderr ?? ""}`);
}

function makePreview(file: string, out: string, transparent: boolean): void {
  const r = spawnSync(ffmpegPath(), [
    "-v",
    "error",
    "-y",
    "-i",
    file,
    "-vf",
    "scale='min(768,iw)':-2",
    ...(transparent ? [] : ["-q:v", "4"]),
    out,
  ]);
  if (r.status !== 0) throw new Error(`could not make a preview of ${file}`);
}

/**
 * Copies the editor's images into <outDir>/assets as a1.png, a2.jpg..., measures them and writes
 * assets.json. Unreadable or unsupported files stop the job with a clear message.
 */
export function prepareAssets(inputs: AssetInput[], outDir: string): PreparedAsset[] {
  if (!inputs.length) return [];
  const dir = join(outDir, "assets");
  const previews = join(outDir, "asset-previews");
  mkdirSync(dir, { recursive: true });
  mkdirSync(previews, { recursive: true });
  const prepared = inputs.map((input, i): PreparedAsset => {
    const ext = extname(input.path).toLowerCase();
    if (!(ASSET_EXTENSIONS as readonly string[]).includes(ext))
      throw new Error(
        `Image ${input.path} is not supported; use ${ASSET_EXTENSIONS.join(", ")} files.`,
      );
    if (!existsSync(input.path)) throw new Error(`Image not found: ${input.path}`);
    const id = `a${i + 1}`;
    const name = `${id}${ext === ".jpeg" ? ".jpg" : ext}`;
    copyFileSync(input.path, join(dir, name));
    const { width, height, hasAlpha } = probe(join(dir, name));
    const previewFile = join(previews, `${id}.${hasAlpha ? "png" : "jpg"}`);
    makePreview(join(dir, name), previewFile, hasAlpha);
    return {
      id,
      src: `assets/${name}`,
      width,
      height,
      has_alpha: hasAlpha,
      note: input.note?.trim() || null,
      preview: {
        mediaType: hasAlpha ? "image/png" : "image/jpeg",
        base64: readFileSync(previewFile).toString("base64"),
      },
    };
  });
  writeFileSync(
    join(outDir, "assets.json"),
    `${JSON.stringify(
      prepared.map(({ preview: _p, ...info }) => info),
      null,
      2,
    )}\n`,
  );
  return prepared;
}

/** Reads assets.json back for a review run (render or recompose); empty when the job had no images. */
export function readAssets(outDir: string): AssetInfo[] {
  const file = join(outDir, "assets.json");
  if (!existsSync(file)) return [];
  return z.array(AssetInfoSchema).parse(JSON.parse(readFileSync(file, "utf8")));
}

/** The preview of a prepared asset again, for a recompose that needs the model to see it. */
export function assetPreview(outDir: string, info: AssetInfo): PreparedAsset["preview"] | null {
  const file = join(outDir, "asset-previews", `${info.id}.${info.has_alpha ? "png" : "jpg"}`);
  if (!existsSync(file)) return null;
  return {
    mediaType: info.has_alpha ? "image/png" : "image/jpeg",
    base64: readFileSync(file).toString("base64"),
  };
}
