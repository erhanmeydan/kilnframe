import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The tools that ship inside the packaged app (Contents/Resources/bin on macOS, resources\bin on Windows):
 * FFmpeg, FFprobe, the headless Chrome HyperFrames renders with, the styles and the vendor libraries. In development nothing is bundled and the
 * companion uses what the computer has (ffmpeg on the PATH, Chrome from HyperFrames' cache).
 */
export function bundledTools(resources = process.resourcesPath ?? ""): Record<string, string> {
  const env: Record<string, string> = {};
  if (!resources) return env;
  const bin = join(resources, "bin");
  const exe = (name: string) => join(bin, process.platform === "win32" ? `${name}.exe` : name);
  if (existsSync(exe("ffmpeg"))) {
    env.KILNFRAME_FFMPEG = exe("ffmpeg");
    env.HYPERFRAMES_FFMPEG_PATH = exe("ffmpeg");
  }
  if (existsSync(exe("ffprobe"))) env.HYPERFRAMES_FFPROBE_PATH = exe("ffprobe");
  // styles, recipes and vendor libraries live next to the app, not in a repository
  if (existsSync(join(resources, "styles"))) env.KILNFRAME_STYLES_DIR = join(resources, "styles");
  if (existsSync(join(resources, "recipes")))
    env.KILNFRAME_RECIPES_DIR = join(resources, "recipes");
  if (existsSync(join(resources, "vendor"))) env.KILNFRAME_VENDOR_DIR = join(resources, "vendor");
  const shell = join(
    bin,
    "headless-shell",
    process.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell",
  );
  if (existsSync(shell)) env.PRODUCER_HEADLESS_SHELL_PATH = shell;
  return env;
}
