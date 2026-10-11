import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWorker, type Worker } from "tesseract.js";
import { ffmpegPath, modelsDir, type Defaults } from "./config.js";

/**
 * Reads the text in the editor's screenshots with its position, so a scene can mark the exact line the
 * speaker talks about. Runs locally with tesseract.js;
 * the language files are downloaded once into modelsDir()/tessdata, never fetched from a CDN at run time.
 */

/** A rectangle in the image's own pixels: x, y, width, height. */
export type Box = [number, number, number, number];

export interface OcrWord {
  text: string;
  box: Box;
}

export interface OcrLine {
  id: string;
  text: string;
  confidence: number;
  box: Box;
  words: OcrWord[];
}

const MIN_CONFIDENCE = 60;

export function tessdataDir(): string {
  return join(modelsDir(), "tessdata");
}

/** Downloads the missing language files (about 4.5 MB each); the companion calls this during onboarding. */
export async function ensureOcrData(
  ocr: Defaults["ocr"],
  onProgress?: (message: string) => void,
): Promise<void> {
  const dir = tessdataDir();
  mkdirSync(dir, { recursive: true });
  for (const lang of ocr.languages) {
    const file = join(dir, `${lang}.traineddata`);
    if (existsSync(file)) continue;
    onProgress?.(`Downloading text reader (${lang})`);
    const res = await fetch(`${ocr.dataUrl}/${lang}.traineddata`);
    if (!res.ok || !res.body) throw new Error(`Could not download the ${lang} text reader data.`);
    const part = `${file}.part`;
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(part));
    renameSync(part, file);
  }
}

let workerPromise: Promise<Worker> | null = null;
let workerLangs = "";

async function worker(ocr: Defaults["ocr"]): Promise<Worker> {
  const langs = ocr.languages.join("+");
  if (!workerPromise || workerLangs !== langs) {
    workerLangs = langs;
    workerPromise = createWorker(ocr.languages, 1, {
      langPath: tessdataDir(),
      gzip: false,
      cacheMethod: "none",
    });
  }
  return workerPromise;
}

/** Stops the reader; the CLI calls it so the process can exit. */
export async function closeOcr(): Promise<void> {
  if (!workerPromise) return;
  const w = await workerPromise;
  workerPromise = null;
  await w.terminate();
}

/** How much to enlarge an image so small interface text reaches a size the reader handles well. */
export function ocrScale(width: number): number {
  return width < 1600 ? 3 : width < 2600 ? 2 : 1;
}

/**
 * Three views of the same image: as is (dark text on light), inverted (light text on a dark theme) and a
 * mask of near-white pixels (white text on coloured buttons).
 */
const PASSES = [
  "format=gray",
  "format=gray,negate",
  "format=gray,lut=y='if(gt(val\\,215)\\,0\\,255)'",
] as const;

function overlap(a: Box, b: Box): number {
  const x = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const y = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  const inter = x * y;
  return inter / Math.min(a[2] * a[3], b[2] * b[3] || 1);
}

/** Keeps one line per place: when lines from different passes overlap, the most confident one wins. */
export function mergeLines(lines: Omit<OcrLine, "id">[]): OcrLine[] {
  const kept: Omit<OcrLine, "id">[] = [];
  for (const line of [...lines].sort((a, b) => b.confidence - a.confidence)) {
    if (kept.some((k) => overlap(k.box, line.box) > 0.5)) continue;
    kept.push(line);
  }
  return kept
    .sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0])
    .map((l, i) => ({ id: `l${i + 1}`, ...l }));
}

interface TessBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const toBox = (b: TessBox, scale: number): Box => [
  Math.round(b.x0 / scale),
  Math.round(b.y0 / scale),
  Math.round((b.x1 - b.x0) / scale),
  Math.round((b.y1 - b.y0) / scale),
];

/** Reads the lines of text in an image, with boxes in the image's own pixels. */
export async function readText(
  file: string,
  width: number,
  ocr: Defaults["ocr"],
): Promise<OcrLine[]> {
  const w = await worker(ocr);
  // automatic page layout reads buttons too; debug_file keeps tesseract's notes out of the job log
  await w.setParameters({
    tessedit_pageseg_mode: "3" as never,
    debug_file: process.platform === "win32" ? "NUL" : "/dev/null",
  });
  const scale = ocrScale(width);
  const work = mkdtempSync(join(tmpdir(), "mi-ocr-"));
  const found: Omit<OcrLine, "id">[] = [];
  try {
    for (const [i, filter] of PASSES.entries()) {
      const input = join(work, `pass-${i}.png`);
      const vf = scale > 1 ? `scale=iw*${scale}:ih*${scale}:flags=lanczos,${filter}` : filter;
      const r = spawnSync(ffmpegPath(), ["-v", "error", "-y", "-i", file, "-vf", vf, input]);
      if (r.status !== 0) continue;
      const { data } = await w.recognize(input, {}, { blocks: true });
      for (const block of data.blocks ?? [])
        for (const para of block.paragraphs)
          for (const line of para.lines) {
            const text = line.text.replace(/\s+/g, " ").trim();
            // a real line has at least two letters or digits; single symbols are noise
            if (line.confidence < MIN_CONFIDENCE || (text.match(/[\p{L}\p{N}]/gu) ?? []).length < 2)
              continue;
            found.push({
              text,
              confidence: Math.round(line.confidence),
              box: toBox(line.bbox, scale),
              words: line.words
                .filter((wd) => wd.text.trim())
                .map((wd) => ({ text: wd.text.trim(), box: toBox(wd.bbox, scale) })),
            });
          }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return mergeLines(found);
}

/** Lowercase, Turkish aware, without punctuation, for matching the plan's words to the read words. */
export function normalizeText(s: string): string {
  return s
    .toLocaleLowerCase("tr")
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The union of boxes. */
export function unionBox(boxes: Box[]): Box {
  const x0 = Math.min(...boxes.map((b) => b[0]));
  const y0 = Math.min(...boxes.map((b) => b[1]));
  const x1 = Math.max(...boxes.map((b) => b[0] + b[2]));
  const y1 = Math.max(...boxes.map((b) => b[1] + b[3]));
  return [x0, y0, x1 - x0, y1 - y0];
}

/**
 * The box of a phrase inside a read line: the run of words whose normalized text matches the phrase.
 * Without a phrase, the whole line. Null when the phrase is not in the line.
 */
export function phraseBox(line: OcrLine, phrase?: string | null): Box | null {
  if (!phrase?.trim()) return line.box;
  const want = normalizeText(phrase);
  const words = line.words
    .map((w) => ({ ...w, norm: normalizeText(w.text) }))
    .filter((w) => w.norm);
  for (let i = 0; i < words.length; i++) {
    // grow a run of read words from i; one read word can hold several wanted words ("29,97" is "29 97")
    let buffer = "";
    const used: Box[] = [];
    for (let k = i; k < words.length; k++) {
      buffer = buffer ? `${buffer} ${words[k]?.norm}` : (words[k]?.norm ?? "");
      used.push(words[k]?.box as Box);
      if (buffer === want) return unionBox(used);
      if (!want.startsWith(`${buffer} `)) break;
    }
  }
  return null;
}
