import { SYNTHS, type Params } from "./synths.js";

/** One named sound in a style's palette: which synth to use and how. */
export interface PaletteSound {
  synth: string;
  params?: Params;
  /** Trim added on top of each cue's own gain. */
  gain_db?: number;
}

/** Contents of styles/<style>/sfx.json. */
export interface SfxPalette {
  version: 1;
  /** Master trim for all effects; about 20 LU under speech in the original project. */
  master_db: number;
  /** Stereo spread: each cue gets a seeded pan in [-pan, pan]. */
  pan: number;
  room: { enabled: boolean; db: number };
  sounds: Record<string, PaletteSound>;
  /** Story mode: a short English brief for the music bed (instruments, mood, tempo), read by Lyria. */
  music?: string;
}

export class PaletteError extends Error {}

/** Validates a parsed sfx.json without extra dependencies, with messages a style author can act on. */
export function parsePalette(data: unknown, source = "sfx.json"): SfxPalette {
  const fail = (msg: string): never => {
    throw new PaletteError(`${source}: ${msg}`);
  };
  if (typeof data !== "object" || data === null) fail("must be a JSON object");
  const d = data as Record<string, unknown>;
  if (d.version !== 1) fail('"version" must be 1');
  if (typeof d.master_db !== "number" || d.master_db > 0) fail('"master_db" must be a number <= 0');
  if (typeof d.pan !== "number" || d.pan < 0 || d.pan > 1) fail('"pan" must be between 0 and 1');
  const room = d.room as Record<string, unknown> | undefined;
  if (!room || typeof room.enabled !== "boolean" || typeof room.db !== "number") {
    fail('"room" must be { "enabled": boolean, "db": number }');
  }
  const sounds = d.sounds as Record<string, unknown> | undefined;
  if (!sounds || typeof sounds !== "object" || Object.keys(sounds).length === 0)
    fail('"sounds" must list at least one sound');
  for (const [name, s] of Object.entries(sounds as Record<string, unknown>)) {
    const sound = s as Record<string, unknown>;
    if (typeof sound.synth !== "string" || !(sound.synth in SYNTHS)) {
      fail(
        `sound "${name}" uses unknown synth "${String(sound.synth)}". Available: ${Object.keys(SYNTHS).join(", ")}`,
      );
    }
    if (sound.params !== undefined) {
      if (typeof sound.params !== "object" || sound.params === null)
        fail(`sound "${name}": "params" must be an object`);
      for (const [k, v] of Object.entries(sound.params as Record<string, unknown>)) {
        if (typeof v !== "number") fail(`sound "${name}": param "${k}" must be a number`);
      }
    }
    if (sound.gain_db !== undefined && typeof sound.gain_db !== "number")
      fail(`sound "${name}": "gain_db" must be a number`);
  }
  if (d.music !== undefined && typeof d.music !== "string") fail('"music" must be a string');
  return d as unknown as SfxPalette;
}
