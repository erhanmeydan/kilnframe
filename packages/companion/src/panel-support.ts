import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, posix, resolve as resolvePath, win32 } from "node:path";
import {
  ASSET_EXTENSIONS,
  FAILURE_PICTURE,
  ffmpegPath,
  listStyles,
  loadStyle,
  parseImageStream,
  STILL_FILE,
  styleHome,
  userStylesDir,
  styleSummary,
} from "@kilnframe/core";

/** What the panel's style picker shows for one style. */
export interface StyleCard {
  name: string;
  /** Per panel language, from tokens.json. */
  displayName: Record<string, string>;
  description: Record<string, string>;
  summary: string;
  /** Small 16:9 JPEG of the style's first reference still, as a data URL. */
  thumb: string | null;
  /** Every reference still, 16:9 and larger, for the panel's gallery. */
  stills: string[];
  /**
   * Stills with words in another language (stills/<lang>/, same file names): the panel shows these when
   * it runs in that language. A still without a version there stays the shared one.
   */
  byLang?: Record<string, { thumb: string | null; stills: string[] }>;
  /** A style the editor made; the panel shows these in their own row. */
  custom: boolean;
}

/**
 * Thumbnails are made once with FFmpeg and cached; the panel gets them inline as data URLs. The reference
 * stills are 3:2, the panel shows them 16:9 like the video, so the middle band is kept.
 */
function thumbnail(still: string, cacheDir: string, width: number, lang = ""): string | null {
  const style = basename(dirname(dirname(lang ? dirname(still) : still)));
  const out = join(
    cacheDir,
    `${style}-${lang ? `${lang}-` : ""}${basename(still).replace(STILL_FILE, "")}-${width}.jpg`,
  );
  if (!existsSync(out) || statSync(out).mtimeMs < statSync(still).mtimeMs) {
    mkdirSync(cacheDir, { recursive: true });
    const r = spawnSync(ffmpegPath(), [
      "-v",
      "error",
      "-y",
      "-i",
      still,
      "-vf",
      `crop=iw:iw*9/16,scale=${width}:${Math.round((width * 9) / 16 / 2) * 2}`,
      "-q:v",
      "5",
      out,
    ]);
    if (r.status !== 0) return null;
  }
  return `data:image/jpeg;base64,${readFileSync(out).toString("base64")}`;
}

export function styleCards(cacheDir: string, dir?: string): StyleCard[] {
  return listStyles(dir).map((name) => {
    const style = loadStyle(name, dir);
    const home = dir ?? styleHome(name) ?? "";
    // an editor's style shows its rendered previews, or its references before the first preview
    const rendered = join(home, name, "stills");
    const stillsDir = existsSync(rendered) ? rendered : join(home, name, "references");
    const files = existsSync(stillsDir)
      ? readdirSync(stillsDir)
          .filter((f) => STILL_FILE.test(f))
          .sort()
          .map((f) => join(stillsDir, f))
      : [];
    const langs = existsSync(stillsDir)
      ? readdirSync(stillsDir).filter((d) => /^[a-z]{2}$/.test(d))
      : [];
    const byLang = Object.fromEntries(
      langs.map((lang) => {
        const own = (f: string) => {
          const local = join(stillsDir, lang, basename(f));
          return existsSync(local) ? { file: local, lang } : { file: f, lang: "" };
        };
        const list = files.map(own);
        return [
          lang,
          {
            thumb: list[0] ? thumbnail(list[0].file, cacheDir, 320, list[0].lang) : null,
            stills: list
              .map((f) => thumbnail(f.file, cacheDir, 640, f.lang))
              .filter((t): t is string => t !== null),
          },
        ];
      }),
    );
    return {
      name,
      displayName: style.displayName,
      description: style.description,
      summary: styleSummary(style),
      custom: style.custom,
      thumb: files[0] ? thumbnail(files[0], cacheDir, 320) : null,
      stills: files.map((f) => thumbnail(f, cacheDir, 640)).filter((t): t is string => t !== null),
      ...(langs.length ? { byLang } : {}),
    };
  });
}

/**
 * Where speech.clone writes its sample: next to the audio in a `voice-fix` folder, else in a `voice-fix`
 * folder beside it, so audio.play may play it.
 */
export function voiceSampleFile(audioPath: string): string {
  const dir = dirname(audioPath);
  return basename(dir) === "voice-fix"
    ? join(dir, "voice-sample.wav")
    : join(dir, "voice-fix", "voice-sample.wav");
}

/** Folder-safe text: keeps letters (Turkish too), digits, dash and underscore. */
export function safeName(text: string): string {
  return (
    text
      .normalize("NFC")
      .replace(/[^\p{L}\p{N}_-]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "sequence"
  );
}

/**
 * True when `child` lies inside `parent` (not the folder itself). Windows paths ignore letter case: Resolve
 * may give c:\Users\… for a home folder of C:\Users\….
 */
export function insideFolder(
  child: string,
  parent: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const path = platform === "win32" ? win32 : posix;
  const rel = path.relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}

/**
 * A new job folder next to the Premiere project: <project folder>/Motion
 * Inserts/<sequence>-<time>. Without a saved project the folder goes under ~/.kilnframe/jobs.
 */
export function prepareJobDir(
  projectPathIn: string | undefined,
  sequenceName: string,
  now = new Date(),
  /** jobRoot: a folder for the job folders when there is no project file (Resolve); only inside `home`. */
  opts: { jobRoot?: string | undefined; home?: string } = {},
): string {
  const projectPath = projectPathIn && withoutLongPathPrefix(projectPathIn);
  const home = resolvePath(opts.home ?? homedir());
  const root = opts.jobRoot ? resolvePath(opts.jobRoot) : null;
  if (root && !insideFolder(root, home))
    throw new Error(`The job folder root must be inside the home folder: ${opts.jobRoot}`);
  const base = root
    ? root
    : projectPath && existsSync(dirname(projectPath))
      ? join(dirname(projectPath), "Kilnframe")
      : join(process.env.KILNFRAME_HOME ?? join(homedir(), ".kilnframe"), "jobs");
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const dir = join(base, `${safeName(sequenceName)}-${stamp}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const PRESET = join(
  "MediaIO",
  "systempresets",
  "3F3F3F3F_57415645",
  "Waveform Audio 48kHz 16-bit.epr",
);

/**
 * Where a running Premiere keeps its files (on macOS the .app's Contents folder, on Windows the folder of the
 * .exe), from the process list: `ps -axo comm=` on macOS, the paths PowerShell gives on Windows. Premiere can
 * be installed anywhere, e.g. in the Documents folder, where the usual places miss it (2 Nov 2026).
 */
export function premiereDirsFrom(list: string, platform: NodeJS.Platform): string[] {
  const dirs: string[] = [];
  for (const line of list.split(/\r?\n/).map((l) => l.trim())) {
    if (platform === "win32") {
      if (/[\\/]Adobe Premiere Pro[^\\/]*\.exe$/i.test(line)) dirs.push(win32.dirname(line));
    } else {
      const at = line.indexOf(".app/Contents/MacOS/");
      if (at > 0 && /\/Adobe Premiere Pro[^/]*\.app$/.test(line.slice(0, at + 4)))
        dirs.push(line.slice(0, at + ".app/Contents".length));
    }
  }
  return [...new Set(dirs)];
}

/** The running Premieres' folders (premiereDirsFrom); none when Premiere is not running or the list fails. */
export function runningPremiereDirs(platform = process.platform): string[] {
  const r =
    platform === "win32"
      ? spawnSync(
          "powershell",
          [
            "-NoProfile",
            "-Command",
            "(Get-Process -Name 'Adobe Premiere Pro*' -ErrorAction SilentlyContinue).Path",
          ],
          { encoding: "utf8", windowsHide: true, timeout: 10_000 },
        )
      : spawnSync("ps", ["-axo", "comm="], { encoding: "utf8", timeout: 10_000 });
  return r.status === 0 ? premiereDirsFrom(r.stdout, platform) : [];
}

/**
 * A preset that ships inside Premiere (MediaIO/systempresets/...): first in the running Premiere, then in
 * the installed Premiere versions in the usual places, newest first.
 */
function findPremierePreset(
  preset: string,
  platform: NodeJS.Platform,
  running: string[],
): string | null {
  const candidates = running.map((dir) => join(dir, preset));
  const roots =
    platform === "win32"
      ? [join(process.env.ProgramFiles ?? "C:\\Program Files", "Adobe")]
      : ["/Applications"];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)
      .filter((n) => /^Adobe Premiere Pro/.test(n))
      .sort()
      .reverse()) {
      if (platform === "win32") candidates.push(join(root, name, preset));
      else {
        const appDir = join(root, name);
        const apps =
          existsSync(appDir) && statSync(appDir).isDirectory()
            ? readdirSync(appDir).filter((n) => n.endsWith(".app"))
            : [];
        for (const app of apps) candidates.push(join(appDir, app, "Contents", preset));
        if (name.endsWith(".app")) candidates.push(join(root, name, "Contents", preset));
      }
    }
  }
  return candidates.find((c) => existsSync(c)) ?? null;
}

/** Premiere's 48 kHz WAV export preset (checked in 26.5.2). */
export function findWavPreset(
  platform = process.platform,
  running: string[] = runningPremiereDirs(platform),
): string | null {
  return findPremierePreset(PRESET, platform, running);
}

/**
 * Premiere's own H.264 "Match Source, Low bitrate" preset: the panel exports the range's picture with it,
 * so the preview shows the insert over the real footage (checked in Premiere 26.5).
 */
const PREVIEW_PRESET = join(
  "MediaIO",
  "systempresets",
  "4E49434B_48323634",
  "02 - Match Source - Low bitrate.epr",
);

export function findPreviewPreset(
  platform = process.platform,
  running: string[] = runningPremiereDirs(platform),
): string | null {
  return findPremierePreset(PREVIEW_PRESET, platform, running);
}

/** The review screen's stills as small JPEG data URLs, one per scene in plan order. */
export function stillImages(
  stills: string[],
  sceneIds: string[],
): { sceneId: string; file: string; image: string | null }[] {
  return stills.map((file, i) => {
    const out = file.replace(/\.png$/i, "-small.jpg");
    const r = spawnSync(ffmpegPath(), [
      "-v",
      "error",
      "-y",
      "-i",
      file,
      "-vf",
      "scale=480:-2",
      "-q:v",
      "4",
      out,
    ]);
    return {
      sceneId: sceneIds[i] ?? `s${i + 1}`,
      file,
      image:
        r.status === 0 ? `data:image/jpeg;base64,${readFileSync(out).toString("base64")}` : null,
    };
  });
}

/**
 * The caption clip's inputs for a preview: the transparent clip first, then the footage frame (or a dark
 * ground) as a looping picture that the filter scales to the clip's size.
 */
function overFootage(video: string, frame: string | null): string[] {
  return [
    "-i",
    video,
    ...(frame ? ["-loop", "1", "-i", frame] : ["-f", "lavfi", "-i", "color=c=0x1e1e1e:s=16x16"]),
  ];
}
const OVER = "[1:v][0:v]scale2ref[bg][fg];[bg][fg]overlay=shortest=1:format=auto";

/**
 * The Captions tab's "Play" for a panel that cannot play video: `count` frames spread over the caption clip,
 * each over the footage frame, as small JPEG data URLs in time order.
 */
export function captionFrames(
  video: string,
  frame: string | null,
  durationS: number,
  count: number,
  outDir: string,
): string[] {
  mkdirSync(outDir, { recursive: true });
  const step = durationS / count;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const file = join(outDir, `frame-${i + 1}.jpg`);
    const r = spawnSync(ffmpegPath(), [
      "-v",
      "error",
      "-y",
      ...overFootage(video, frame),
      "-filter_complex",
      `${OVER},scale='min(480,iw)':-2`,
      // seeking the output, not the clip: a seeked clip loses its timing against the looped frame and the
      // overlay shows the footage alone
      "-ss",
      ((i + 0.5) * step).toFixed(3),
      "-frames:v",
      "1",
      "-q:v",
      "4",
      file,
    ]);
    if (r.status !== 0) throw new Error(`could not take frame ${i + 1} of the caption preview`);
    out.push(`data:image/jpeg;base64,${readFileSync(file).toString("base64")}`);
  }
  return out;
}

/** The same preview as a short H.264 clip over the footage frame, for a panel that plays video. */
export function captionClip(video: string, frame: string | null, outDir: string): string | null {
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, "preview.mp4");
  const r = spawnSync(ffmpegPath(), [
    "-v",
    "error",
    "-y",
    ...overFootage(video, frame),
    "-filter_complex",
    `${OVER},scale='min(480,iw)':-2,format=yuv420p`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "26",
    "-movflags",
    "+faststart",
    "-an",
    file,
  ]);
  return r.status === 0 ? `data:video/mp4;base64,${readFileSync(file).toString("base64")}` : null;
}

/** What the panel shows for one image the editor picked, or why it cannot be used. */
export interface ImageCard {
  path: string;
  name: string;
  width?: number;
  height?: number;
  hasAlpha?: boolean;
  /** Small preview as a data URL. */
  thumb?: string;
  error?: string;
}

/** Checks the editor's images before the job: type, readable, size; makes a small thumbnail of each. */
export function inspectImages(paths: string[], cacheDir: string): ImageCard[] {
  mkdirSync(cacheDir, { recursive: true });
  return paths.map((path, i): ImageCard => {
    const name = basename(path);
    if (!(ASSET_EXTENSIONS as readonly string[]).includes(extname(path).toLowerCase()))
      return { path, name, error: "unsupported" };
    if (!existsSync(path)) return { path, name, error: "missing" };
    let info: { width: number; height: number; hasAlpha: boolean };
    try {
      const r = spawnSync(ffmpegPath(), ["-hide_banner", "-i", path], { encoding: "utf8" });
      info = parseImageStream(`${r.stderr ?? ""}`);
    } catch {
      return { path, name, error: "unreadable" };
    }
    const out = join(cacheDir, `img-${Date.now()}-${i}.${info.hasAlpha ? "png" : "jpg"}`);
    const r = spawnSync(ffmpegPath(), [
      "-v",
      "error",
      "-y",
      "-i",
      path,
      "-vf",
      "scale='min(240,iw)':-2",
      ...(info.hasAlpha ? [] : ["-q:v", "5"]),
      out,
    ]);
    return {
      path,
      name,
      ...info,
      ...(r.status === 0
        ? {
            thumb: `data:image/${info.hasAlpha ? "png" : "jpeg"};base64,${readFileSync(out).toString("base64")}`,
          }
        : {}),
    };
  });
}

/**
 * Deletes one of the editor's own styles. Only folders this tool made (they carry meta.json) inside the user
 * styles folder; a shipped preset can never be deleted this way.
 */
export function deleteUserStyle(name: string): void {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`Not a style name: ${name}`);
  const dir = join(userStylesDir(), name);
  if (!existsSync(join(dir, "meta.json")))
    throw new Error(`There is no style of yours named ${name}.`);
  rmSync(dir, { recursive: true, force: true });
}

/** The words a voice preview says, in the story's language. */
export function previewText(voice: string, language: string): string {
  return language.startsWith("tr")
    ? `Merhaba, ben ${voice}. Hikayenizi bu sesle, bu tonda anlatırım.`
    : `Hi, I am ${voice}. This is how I would tell your story.`;
}

/** Plays a sound file with the system's own player, without waiting for it to finish. */
/** The sample playing now, so a new one or Stop can end it. */
let playing: ChildProcess | null = null;

/** Ends the sample that is playing, if any. */
export function stopSound(): boolean {
  if (!playing) return false;
  playing.kill();
  playing = null;
  return true;
}

/** Plays a sound file on the computer's speakers; a sample already playing stops first. */
export function playSound(file: string, onEnd?: () => void): void {
  stopSound();
  const cmd =
    process.platform === "win32"
      ? [
          "powershell",
          [
            "-NoProfile",
            "-Command",
            `(New-Object Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`,
          ],
        ]
      : ["afplay", [file]];
  const child = spawn(cmd[0] as string, cmd[1] as string[], { stdio: "ignore" });
  playing = child;
  const ended = () => {
    if (playing !== child) return;
    playing = null;
    onEnd?.();
  };
  child.on("error", ended);
  child.on("exit", ended);
}

/**
 * A job folder's review from disk: its stills and frame size. A long range made in parts outlives the panel and
 * the companion, so its review must not depend on a job result kept in memory.
 */
export function reviewFromDisk(outDir: string): {
  stillImages: { sceneId: string; file: string; image: string | null }[];
  plan: { width: number; height: number };
} | null {
  const planFile = join(outDir, "plan.json");
  const stillsDir = join(outDir, "stills");
  if (!existsSync(planFile) || !existsSync(stillsDir)) return null;
  const plan = JSON.parse(readFileSync(planFile, "utf8")) as {
    width: number;
    height: number;
    scenes: { id: string }[];
  };
  const frames = readdirSync(stillsDir)
    .filter((f) => /^frame-\d+-at-.*\.png$/.test(f))
    .sort()
    .map((f) => join(stillsDir, f));
  if (frames.length !== plan.scenes.length) return null;
  const edges = join(stillsDir, "edges.json");
  let cut: string[] = [];
  try {
    if (existsSync(edges)) cut = JSON.parse(readFileSync(edges, "utf8")) as string[];
  } catch {
    // an unreadable note file: no notes
  }
  return {
    stillImages: stillImages(
      frames,
      plan.scenes.map((s) => s.id),
    ).map((st) => (cut.includes(st.sceneId) ? { ...st, edgeCut: true } : st)),
    plan: { width: plan.width, height: plan.height },
  };
}

/**
 * A Windows path without the \\?\ long-path prefix, which Premiere puts on project paths (11 Oct 2026): FFmpeg
 * cannot open "\\?\C:\...\sequence.wav" ("Invalid argument").
 */
export function withoutLongPathPrefix(path: string): string {
  if (path.startsWith("\\\\?\\UNC\\")) return `\\\\${path.slice(8)}`;
  if (path.startsWith("\\\\?\\") || path.startsWith("//?/")) return path.slice(4);
  return path;
}

/**
 * The Captions tab's previews live under the app's own folder, never in the editor's project: `frames/` holds
 * the footage frames the panel exports for them (a fixed name per use, overwritten), `runs/` one folder per
 * preview job. A stopped preview's worker is killed before it can clean up, so `runs/` is emptied when the
 * next preview starts and the whole folder when the app starts.
 */
export function captionPreviewRoot(): string {
  return join(process.env.KILNFRAME_HOME ?? join(homedir(), ".kilnframe"), "previews", "captions");
}

/** The folder the panel exports the previews' footage frames into. */
export function captionPreviewFrames(): string {
  const dir = join(captionPreviewRoot(), "frames");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A new, empty folder for one preview job; whatever earlier (stopped) previews left is removed first. */
export function captionPreviewRun(): string {
  const runs = join(captionPreviewRoot(), "runs");
  rmSync(runs, { recursive: true, force: true });
  const dir = join(runs, randomUUID().slice(0, 8));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Removes every caption preview file; the app calls it when it starts. */
export function clearCaptionPreviews(): void {
  rmSync(captionPreviewRoot(), { recursive: true, force: true });
}

/** The caption job folder's own file: the text job's words, and the tab's lines and choices under `panel`. */
const CAPTIONS_FILE = "captions.json";

/**
 * Keeps the Captions tab's state (lines with the editor's edits, look, colours, range, the placed clip) in its
 * job folder, beside what the text job wrote there, so the tab can come back to the text later.
 */
export function saveCaptionsState(jobDir: string, state: unknown): void {
  const dir = resolvePath(jobDir);
  if (!existsSync(dir) || !statSync(dir).isDirectory())
    throw new Error(`There is no caption job folder at ${jobDir}`);
  const file = join(dir, CAPTIONS_FILE);
  let kept: Record<string, unknown> = {};
  try {
    const read = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (read && typeof read === "object" && !Array.isArray(read))
      kept = read as Record<string, unknown>;
  } catch {
    // no file yet, or one that cannot be read: written anew
  }
  writeFileSync(file, JSON.stringify({ ...kept, panel: state }, null, 2));
}

/** What a caption job folder keeps (see saveCaptionsState), or null when it has nothing readable. */
export function loadCaptionsState(jobDir: string): Record<string, unknown> | null {
  try {
    const read = JSON.parse(
      readFileSync(join(resolvePath(jobDir), CAPTIONS_FILE), "utf8"),
    ) as unknown;
    return read && typeof read === "object" && !Array.isArray(read)
      ? (read as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The frame a failed check points at, marked (core failure-picture.ts), as a data URL for the panel's error;
 * only for the check failure that made it, so a picture left from an earlier attempt is never shown.
 */
export function failurePictureFor(
  outDir: string | undefined,
  message: string,
): { picture: string; pictureWidth: number; pictureHeight: number } | null {
  if (!outDir || !message.includes("still fails validation")) return null;
  const file = join(outDir, FAILURE_PICTURE);
  if (!existsSync(file)) return null;
  try {
    // the frame's shape, so the panel can make room for it before the image loads
    const plan = JSON.parse(readFileSync(join(outDir, "plan.json"), "utf8")) as {
      width: number;
      height: number;
    };
    return {
      picture: `data:image/jpeg;base64,${readFileSync(file).toString("base64")}`,
      pictureWidth: plan.width,
      pictureHeight: plan.height,
    };
  } catch {
    return null;
  }
}
