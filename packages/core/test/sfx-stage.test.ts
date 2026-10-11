import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { decodeWav16 } from "@kilnframe/sfx";
import { describe, expect, it } from "vitest";
import { PlanSchema, planCues, renderSfx } from "../src/index.js";

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
    expect(r.stems.map((s) => basename(s)).sort()).toEqual(["room.wav", "thock.wav"]);
    const mix = decodeWav16(readFileSync(r.mix));
    expect(mix.channels).toHaveLength(2);
    expect(mix.channels[0]?.length).toBe(Math.round(((300 + 40) * 1001 * 48000) / 30000));
    expect(r.peakDb).toBeLessThan(-1);
  });
});
