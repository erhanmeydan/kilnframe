import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { kilnframeFile, saveCopy } from "../src/resolve/paths";

function home() {
  const h = mkdtempSync(join(tmpdir(), "kf-home-"));
  mkdirSync(join(h, ".kilnframe"), { recursive: true });
  mkdirSync(join(h, "Library", "LaunchAgents"), { recursive: true });
  return h;
}

describe("resolve panel file access", () => {
  it("allows Kilnframe's own folder: the connection file and the panel log", () => {
    const h = home();
    expect(kilnframeFile(join(h, ".kilnframe", "companion.json"), h)).toBe(
      join(h, ".kilnframe", "companion.json"),
    );
    expect(kilnframeFile(join(h, ".kilnframe", "new", "panel-log.txt"), h)).toBe(
      join(h, ".kilnframe", "new", "panel-log.txt"),
    );
  });

  it("refuses the rest of the home folder and tricks with ..", () => {
    const h = home();
    expect(() => kilnframeFile(join(h, "Library", "LaunchAgents", "x.plist"), h)).toThrow();
    expect(() => kilnframeFile(join(h, ".zshrc"), h)).toThrow();
    expect(() => kilnframeFile(join(h, ".kilnframe", "..", ".zshrc"), h)).toThrow();
    expect(() => kilnframeFile(join(h, ".kilnframe-evil", "a"), h)).toThrow();
  });

  it("refuses a symlink inside Kilnframe's folder that points elsewhere", () => {
    const h = home();
    symlinkSync(join(h, "Library", "LaunchAgents"), join(h, ".kilnframe", "out"));
    expect(() => kilnframeFile(join(h, ".kilnframe", "out", "x.plist"), h)).toThrow();
  });

  it("copies a caption SRT from the home folder to where the editor picks, nothing on cancel", async () => {
    const h = home();
    const job = join(h, "Movies", "Kilnframe", "P", "Talk Captions-1");
    mkdirSync(job, { recursive: true });
    const srt = join(job, "captions-1.srt");
    writeFileSync(srt, "1\n00:00:10,200 --> 00:00:11,400\nMerhaba\n");
    const asked: string[] = [];
    const target = join(h, "Desktop", "Talk captions-1.srt");
    mkdirSync(join(h, "Desktop"));
    expect(
      await saveCopy(srt, "Talk captions-1.srt", h, async (name) => {
        asked.push(name);
        return target;
      }),
    ).toBe(target);
    expect(asked).toEqual(["Talk captions-1.srt"]);
    expect(readFileSync(target, "utf8")).toBe(readFileSync(srt, "utf8"));
    expect(await saveCopy(srt, "x.srt", h, async () => null)).toBeNull();
  });

  it("copies only an SRT inside the home folder", async () => {
    const h = home();
    writeFileSync(join(h, ".zshrc"), "secret");
    const pick = async () => join(h, "out.srt");
    await expect(saveCopy(join(h, ".zshrc"), "a.srt", h, pick)).rejects.toThrow();
    await expect(saveCopy("/etc/hosts.srt", "a.srt", h, pick)).rejects.toThrow();
    expect(existsSync(join(h, "out.srt"))).toBe(false);
  });
});
