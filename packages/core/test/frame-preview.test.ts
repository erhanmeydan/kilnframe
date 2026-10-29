import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { framePreview } from "../src/frames.js";
import { ffmpegPath } from "../src/config.js";

describe("framePreview", () => {
  it("sends a 4K frame as a small JPEG", () => {
    const dir = mkdtempSync(join(tmpdir(), "frame-"));
    const file = join(dir, "big.png");
    spawnSync(ffmpegPath(), [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=2160x3840",
      "-frames:v",
      "1",
      file,
    ]);
    const p = framePreview(file);
    expect(p.mediaType).toBe("image/jpeg");
    const bytes = Buffer.from(p.base64, "base64");
    expect(bytes[0]).toBe(0xff);
    expect(bytes.length).toBeLessThan(1_000_000);
  });
});
