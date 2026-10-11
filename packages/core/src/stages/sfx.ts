import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mixCues, parsePalette, peak, writeWav16, type Cue, type SfxPalette } from "@kilnframe/sfx";
import { framesToSeconds, parseFps } from "../fps.js";
import type { Plan } from "../schemas/plan.js";
import { styleHome, stylesDir } from "../styles.js";

export function loadPalette(style: string, dir = styleHome(style) ?? stylesDir()): SfxPalette {
  const path = join(dir, style, "sfx.json");
  return parsePalette(JSON.parse(readFileSync(path, "utf8")), path);
}

/** Plan cues are body frames; the delivered files start with the handle, so shift by it. */
export function planCues(plan: Plan): Cue[] {
  const fps = parseFps(plan.fps);
  return plan.scenes
    .flatMap((s) => s.sfx)
    .map((c) => ({
      timeS: framesToSeconds(plan.handles_frames + c.frame, fps),
      sound: c.type,
      gainDb: c.gain_db,
    }))
    .sort((a, b) => a.timeS - b.timeS);
}

export interface SfxResult {
  mix: string;
  stems: string[];
  skipped: string[];
  peakDb: number;
}

/** Writes sfx_mix.wav and sfx_stems/<sound>.wav, aligned to the delivered video including handles. */
export function renderSfx(
  plan: Plan,
  outDir: string,
  palette = loadPalette(plan.style),
): SfxResult {
  const fps = parseFps(plan.fps);
  const durationS = framesToSeconds(plan.duration_frames + 2 * plan.handles_frames, fps);
  const result = mixCues({ cues: planCues(plan), palette, durationS });
  const stemDir = join(outDir, "sfx_stems");
  mkdirSync(stemDir, { recursive: true });
  const mix = join(outDir, "sfx_mix.wav");
  writeWav16(mix, [result.mix.left, result.mix.right]);
  const stems = [...result.stems.entries()].map(([name, st]) => {
    const path = join(stemDir, `${name}.wav`);
    writeWav16(path, [st.left, st.right]);
    return path;
  });
  const p = Math.max(peak(result.mix.left), peak(result.mix.right));
  return {
    mix,
    stems,
    skipped: result.skipped.map(
      (s) => `${s.cue.sound} at ${s.cue.timeS.toFixed(2)} s: ${s.reason}`,
    ),
    peakDb: 20 * Math.log10(Math.max(p, 1e-9)),
  };
}
