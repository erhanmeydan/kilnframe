import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { decodeWav16 } from "@kilnframe/sfx";
import { describe, expect, it } from "vitest";
import { PlanSchema, loadPalette, planCues, renderSfx } from "../src/index.js";

const fixture = join(import.meta.dirname, "../../../examples/pipeline/kil-iki-sahne/plan.json");
const plan = PlanSchema.parse(JSON.parse(readFileSync(fixture, "utf8")));

describe("sfx stage", () => {
  it("shifts plan cues by the handle so they line up with the delivered video", () => {
    const cues = planCues(plan);
    expect(cues.map((c) => c.sound)).toEqual(["thock", "thock"]);
    expect(cues[0]?.timeS).toBeCloseTo(((20 + 23) * 1001) / 30000, 6);
  });

  it("writes a mix and one stem per sound, as long as the delivered video", () => {
    const out = mkdtempSync(join(tmpdir(), "mi-sfx-"));
    const r = renderSfx(plan, out);
    expect(r.skipped).toEqual([]);
    // no room tone under the effects: the editor's own recording has its room already
    expect(r.stems.map((s) => basename(s)).sort()).toEqual(["thock.wav"]);
    const mix = decodeWav16(readFileSync(r.mix));
    expect(mix.channels).toHaveLength(2);
    expect(mix.channels[0]?.length).toBe(Math.round(((300 + 40) * 1001 * 48000) / 30000));
    expect(r.peakDb).toBeLessThan(-1);
  });
});

describe("room tone", () => {
  it("stays off even when a style's sfx.json turns it on", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "mi-style-"));
    mkdirSync(join(dir, "mine"));
    writeFileSync(
      join(dir, "mine", "sfx.json"),
      JSON.stringify({
        version: 1,
        master_db: -6,
        pan: 0,
        room: { enabled: true, db: -54 },
        sounds: { thock: { synth: "thock", params: {} } },
      }),
    );
    expect(loadPalette("mine", dir).room.enabled).toBe(false);
  });
});
