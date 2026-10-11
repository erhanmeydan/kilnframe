// The FFmpeg and FFprobe the app ships: fixed builds of FFmpeg 9.0.2, downloaded once per machine into
// ~/.cache/kilnframe-ffmpeg and checked against their published SHA-256. ffmpeg-static (FFmpeg 6.0) is not used:
// its ProRes 4444 frame headers carry an alpha flag Premiere Pro ignores, so overlay inserts showed a black
// ground. checkProresAlpha() guards against that coming back with a future build.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const BUILDS = {
  // signed builds from Martin Riedl's build server (https://ffmpeg.martin-riedl.de), GPL
  "mac-arm64": {
    version: "9.0.2",
    source: "https://ffmpeg.martin-riedl.de/info/detail/macos/arm64/1789931890_9.0.2",
    files: [
      {
        url: "https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip",
        sha256: "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924",
        binaries: { ffmpeg: "ffmpeg" },
      },
      {
        url: "https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffprobe.zip",
        sha256: "fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6",
        binaries: { ffprobe: "ffprobe" },
      },
    ],
  },
  // BtbN's month-end build (kept for two years), GPL, static
  "win-x64": {
    version: "9.0.2",
    source: "https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-09-30-13-08",
    files: [
      {
        url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-30-13-08/ffmpeg-n9.0.2-17-g2a571b6068-win64-gpl-9.0.zip",
        sha256: "a0e45723c72141975f51d8666302e614711745f3102b704ca3f82c897a58d278",
        binaries: {
          "ffmpeg.exe": "ffmpeg-n9.0.2-17-g2a571b6068-win64-gpl-9.0/bin/ffmpeg.exe",
          "ffprobe.exe": "ffmpeg-n9.0.2-17-g2a571b6068-win64-gpl-9.0/bin/ffprobe.exe",
        },
      },
    ],
  },
};

export function ffmpegBuild(platform, arch) {
  const build = BUILDS[`${platform}-${arch}`];
  if (!build) throw new Error(`No FFmpeg build is pinned for ${platform}-${arch}.`);
  return build;
}

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** Copies the pinned ffmpeg and ffprobe for this platform into `dest`, downloading them when not cached. */
export async function fetchFfmpeg(platform, arch, dest) {
  const build = ffmpegBuild(platform, arch);
  const cache = join(
    homedir(),
    ".cache",
    "kilnframe-ffmpeg",
    `${platform}-${arch}-${build.version}`,
  );
  mkdirSync(cache, { recursive: true });
  for (const file of build.files) {
    const zip = join(cache, file.url.split("/").pop());
    if (!existsSync(zip) || sha256(zip) !== file.sha256) {
      console.log(`downloading ${file.url}`);
      const res = await fetch(file.url);
      if (!res.ok) throw new Error(`${file.url}: HTTP ${res.status}`);
      writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    }
    const sum = sha256(zip);
    if (sum !== file.sha256) throw new Error(`${zip}: SHA-256 ${sum}, expected ${file.sha256}`);
    const out = join(cache, "x");
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out);
    // bsdtar reads zip files on macOS and on Windows 10 and later
    execFileSync("tar", ["-xf", zip, "-C", out]);
    for (const [name, inside] of Object.entries(file.binaries)) {
      const bin = join(out, inside);
      if (!existsSync(bin)) throw new Error(`${inside} is not in ${zip}`);
      writeFileSync(join(dest, name), readFileSync(bin), { mode: 0o755 });
    }
  }
  return build;
}

/**
 * Encodes two transparent frames to ProRes 4444 with `ffmpeg` and checks the first frame header the way
 * Premiere Pro reads it: header version 1, and an alpha byte with nothing but the alpha type (2, 16 bit).
 */
export function checkProresAlpha(ffmpeg) {
  const dir = mkdtempSync(join(tmpdir(), "kilnframe-prores-"));
  try {
    const mov = join(dir, "check.mov");
    execFileSync(ffmpeg, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=black@0.0:s=64x64:d=0.08,format=rgba",
      "-c:v",
      "prores_ks",
      "-profile:v",
      "4444",
      "-pix_fmt",
      "yuva444p12le",
      "-alpha_bits",
      "16",
      "-vendor",
      "apl0",
      mov,
    ]);
    const data = readFileSync(mov);
    const at = data.indexOf("icpf");
    if (at < 0) throw new Error("no ProRes frame in the check file");
    const header = data.subarray(at + 4, at + 4 + 18);
    const version = header.readUInt16BE(2);
    const alpha = header[17];
    if (version !== 1 || alpha !== 0x02)
      throw new Error(
        `${ffmpeg} writes ProRes 4444 frames Premiere shows without alpha (header version ${version}, alpha byte 0x${alpha.toString(16)}).`,
      );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// node scripts/ffmpeg.mjs <path-to-ffmpeg>: run the check alone
if (process.argv[1]?.endsWith("ffmpeg.mjs") && process.argv[2]) {
  checkProresAlpha(process.argv[2]);
  console.log(`${process.argv[2]}: ProRes 4444 alpha header ok`);
}
