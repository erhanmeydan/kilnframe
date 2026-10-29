import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ffmpegPath, stylesDir } from "@kilnframe/core";
import { describe, expect, it } from "vitest";
import {
  captionClip,
  captionFrames,
  deleteUserStyle,
  findWavPreset,
  inspectImages,
  prepareJobDir,
  withoutLongPathPrefix,
  safeName,
  styleCards,
} from "../src/panel-support.js";

/** Width and height from a JPEG's start-of-frame marker. */
function jpegSize(b: Buffer): { width: number; height: number } {
  let i = 2;
  while (i < b.length) {
    const marker = b[i + 1]!;
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc2)
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  throw new Error("no SOF marker");
}

describe("panel support", () => {
  // thumbnails are made once with FFmpeg and cached; both style tests share the cache
  const thumbs = mkdtempSync(join(tmpdir(), "mi-thumbs-"));

  it("lists every style with its display name and a thumbnail", { timeout: 60_000 }, () => {
    const cards = styleCards(thumbs, stylesDir());
    expect(cards).toHaveLength(11);
    const kagit = cards.find((c) => c.name === "kagit-kesik");
    expect(kagit?.displayName).toEqual({ en: "Paper Cut", tr: "Kağıt Kesik" });
    expect(kagit?.thumb).toMatch(/^data:image\/jpeg;base64,/);
    expect(kagit?.summary.length).toBeGreaterThan(40);
    // the gallery: every reference still, cropped to the video's 16:9
    expect(kagit?.stills).toHaveLength(3);
    const jpeg = Buffer.from(kagit!.stills[0]!.split(",")[1]!, "base64");
    expect(jpegSize(jpeg)).toEqual({ width: 640, height: 360 });
    // the whole list goes over the socket in one message, so it must stay small
    expect(JSON.stringify(cards).length).toBeLessThan(3_000_000);
  });

  it(
    "gives a style's English stills where it has them, the shared ones elsewhere",
    { timeout: 60_000 },
    () => {
      const cards = styleCards(thumbs, stylesDir());
      const kinetic = cards.find((c) => c.name === "kinetik-tipografi");
      const en = kinetic?.byLang?.en;
      expect(en?.stills).toHaveLength(3);
      // the words differ (SES / SOUND), the number still is the same picture
      expect(en?.stills[0]).not.toBe(kinetic?.stills[0]);
      expect(en?.thumb).not.toBe(kinetic?.thumb);
      expect(cards.find((c) => c.name === "kagit-kesik")?.byLang).toBeUndefined();
    },
  );

  it("makes a job folder next to the project, with a safe sequence name", () => {
    const root = mkdtempSync(join(tmpdir(), "mi-proj-"));
    const project = join(root, "Belgesel.prproj");
    writeFileSync(project, "");
    const dir = prepareJobDir(project, "Sekans 01 / Giriş", new Date("2026-10-07T05:30:12Z"));
    expect(dir).toBe(join(root, "Kilnframe", "Sekans-01-Giriş-20261007-053012"));
    expect(existsSync(dir)).toBe(true);
    expect(safeName("../../etc")).toBe("etc");
  });

  it("makes a job folder under a given root (Resolve has no project file), inside the home folder only", () => {
    const home = mkdtempSync(join(tmpdir(), "mi-home-"));
    const root = join(home, "Movies", "Kilnframe", "Belgesel");
    const dir = prepareJobDir(undefined, "Timeline 1", new Date("2026-10-07T05:30:12Z"), {
      jobRoot: root,
      home,
    });
    expect(dir).toBe(join(root, "Timeline-1-20261007-053012"));
    expect(existsSync(dir)).toBe(true);
    expect(() =>
      prepareJobDir(undefined, "x", new Date(), { jobRoot: "/etc/kilnframe", home }),
    ).toThrow(/home folder/);
  });

  it("finds Premiere's own WAV preset in an install folder", () => {
    const root = mkdtempSync(join(tmpdir(), "mi-pf-"));
    const preset = join(
      root,
      "Adobe",
      "Adobe Premiere Pro 2026",
      "MediaIO",
      "systempresets",
      "3F3F3F3F_57415645",
    );
    mkdirSync(preset, { recursive: true });
    writeFileSync(join(preset, "Waveform Audio 48kHz 16-bit.epr"), "");
    const saved = process.env.ProgramFiles;
    process.env.ProgramFiles = root;
    try {
      expect(findWavPreset("win32")).toBe(join(preset, "Waveform Audio 48kHz 16-bit.epr"));
    } finally {
      process.env.ProgramFiles = saved;
    }
  });

  it("inspects the editor's images and says why one cannot be used", () => {
    const dir = mkdtempSync(join(tmpdir(), "mi-imgs-"));
    const png = join(dir, "logo.png");
    const r = spawnSync(ffmpegPath(), [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=red@0.5:s=300x120,format=rgba",
      "-frames:v",
      "1",
      png,
    ]);
    expect(r.status).toBe(0);
    writeFileSync(join(dir, "bad.png"), "not an image");
    const cards = inspectImages(
      [png, join(dir, "logo.svg"), join(dir, "gone.png"), join(dir, "bad.png")],
      join(dir, "cache"),
    );
    expect(cards[0]).toMatchObject({ name: "logo.png", width: 300, height: 120, hasAlpha: true });
    expect(cards[0]?.thumb).toMatch(/^data:image\/png;base64,/);
    expect(cards.slice(1).map((c) => c.error)).toEqual(["unsupported", "missing", "unreadable"]);
  });

  it("deletes only styles the editor made", () => {
    const home = mkdtempSync(join(tmpdir(), "mi-own-"));
    const before = process.env.KILNFRAME_USER_STYLES_DIR;
    process.env.KILNFRAME_USER_STYLES_DIR = home;
    try {
      mkdirSync(join(home, "neon-gece"));
      writeFileSync(join(home, "neon-gece", "meta.json"), "{}");
      mkdirSync(join(home, "elle-konmus"));
      deleteUserStyle("neon-gece");
      expect(existsSync(join(home, "neon-gece"))).toBe(false);
      expect(() => deleteUserStyle("elle-konmus")).toThrow(/no style of yours/);
      expect(() => deleteUserStyle("../kil-lacivert")).toThrow(/Not a style name/);
      expect(() => deleteUserStyle("kil-lacivert")).toThrow(/no style of yours/);
    } finally {
      if (before === undefined) delete process.env.KILNFRAME_USER_STYLES_DIR;
      else process.env.KILNFRAME_USER_STYLES_DIR = before;
    }
  });
});

describe("withoutLongPathPrefix", () => {
  it("drops the \\\\?\\ prefix Premiere puts on Windows project paths", () => {
    expect(withoutLongPathPrefix("\\\\?\\C:\\Users\\u\\Desktop\\a.prproj")).toBe(
      "C:\\Users\\u\\Desktop\\a.prproj",
    );
    expect(withoutLongPathPrefix("\\\\?\\UNC\\server\\share\\a.prproj")).toBe(
      "\\\\server\\share\\a.prproj",
    );
    expect(withoutLongPathPrefix("//?/C:/Users/u/a.prproj")).toBe("C:/Users/u/a.prproj");
    expect(withoutLongPathPrefix("/Users/u/a.prproj")).toBe("/Users/u/a.prproj");
  });
});

describe("caption previews", () => {
  /** A transparent ProRes 4444 clip with a red box, as the caption render delivers, and a blue footage frame. */
  function clipAndFrame() {
    const dir = mkdtempSync(join(tmpdir(), "kf-cap-prev-"));
    const video = join(dir, "captions-1.mov");
    const frame = join(dir, "frame.png");
    const a = spawnSync(ffmpegPath(), [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=black@0.0:s=480x270:d=2.5:r=25,format=yuva444p10le,drawbox=x=100:y=200:w=200:h=40:c=red@1:t=fill:replace=1",
      "-c:v",
      "prores_ks",
      "-profile:v",
      "4444",
      "-pix_fmt",
      "yuva444p10le",
      video,
    ]);
    expect(a.status).toBe(0);
    const b = spawnSync(ffmpegPath(), [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=1920x1080",
      "-frames:v",
      "1",
      frame,
    ]);
    expect(b.status).toBe(0);
    return { dir, video, frame };
  }

  it("lays six frames of the caption clip over the footage, as small JPEGs", () => {
    const { dir, video, frame } = clipAndFrame();
    const frames = captionFrames(video, frame, 2.5, 6, join(dir, "frames"));
    expect(frames).toHaveLength(6);
    for (const [i, f] of frames.entries()) {
      expect(f).toMatch(/^data:image\/jpeg;base64,/);
      const jpeg = Buffer.from(f.split(",")[1]!, "base64");
      expect(jpegSize(jpeg)).toEqual({ width: 480, height: 270 });
      // the caption (red) lies over the footage (blue) in every frame, not only the first
      const file = join(dir, `check-${i}.jpg`);
      writeFileSync(file, jpeg);
      const px = (x: number, y: number) =>
        spawnSync(ffmpegPath(), [
          "-v",
          "error",
          "-i",
          file,
          "-vf",
          `crop=1:1:${x}:${y}`,
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "-",
        ]).stdout;
      const [r, , b] = px(200, 220);
      expect(r).toBeGreaterThan(180);
      expect(b).toBeLessThan(80);
      expect(px(20, 20)[2]).toBeGreaterThan(180);
    }
    // without a footage frame the captions sit on a dark ground
    expect(captionFrames(video, null, 2.5, 6, join(dir, "plain"))).toHaveLength(6);
  }, 60_000);

  it("makes a short H.264 clip of the captions over the footage for a panel that plays video", () => {
    const { dir, video, frame } = clipAndFrame();
    const clip = captionClip(video, frame, join(dir, "clip"));
    expect(clip).toMatch(/^data:video\/mp4;base64,/);
    const mp4 = Buffer.from(clip!.split(",")[1]!, "base64");
    expect(mp4.subarray(4, 8).toString()).toBe("ftyp");
  });
});
