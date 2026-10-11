// The app's own updates: electron-updater checks GitHub Releases at start and every six hours,
// never downloads or installs by itself, and tells the companion, which shows it in the panel. The editor's
// click comes back the same way; the companion refuses it while a job runs.
import { app } from "electron";
import electronUpdater from "electron-updater";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppUpdateState } from "@kilnframe/companion";

const { autoUpdater } = electronUpdater;
const SIX_HOURS = 6 * 60 * 60 * 1000;
const firstLine = (m: unknown) =>
  String(m instanceof Error ? m.message : m)
    .split("\n")[0]
    ?.slice(0, 200);

export interface Updates {
  state(): AppUpdateState;
  /** Downloads if needed, then quits and installs; the app reopens on the new version. */
  install(): void;
}

/**
 * `feedUrl` (KILNFRAME_UPDATE_URL) points at a folder with latest-mac.yml / latest.yml instead of GitHub
 * Releases: for testing an update locally, before anything is published.
 */
export function startUpdates(o: {
  current: string;
  onState: (state: AppUpdateState) => void;
  log: (line: string) => void;
  feedUrl?: string | undefined;
}): Updates {
  let state: AppUpdateState = { status: "checking", current: o.current };
  let installing = false;
  const set = (next: Partial<AppUpdateState> & Pick<AppUpdateState, "status">) => {
    state = { current: o.current, ...next };
    o.onState(state);
  };

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = {
    info: (m: unknown) => o.log(`update: ${String(m)}`),
    warn: (m: unknown) => o.log(`update: ${String(m)}`),
    // electron-updater's errors carry the whole HTTP response (headers, cookies); the first line is enough
    error: (m: unknown) => o.log(`update error: ${firstLine(m)}`),
    debug: () => {},
  };
  if (o.feedUrl) {
    // electron-updater reads app-update.yml even with a feed set (for its cache folder), and only a release
    // build has one; a test build gets its own beside the user data
    const config = join(app.getPath("userData"), "app-update-test.yml");
    writeFileSync(
      config,
      `provider: generic\nurl: ${o.feedUrl}\nupdaterCacheDirName: "@kilnframeapp-updater"\n`,
    );
    autoUpdater.updateConfigPath = config;
    autoUpdater.setFeedURL({ provider: "generic", url: o.feedUrl });
  }

  const notes = (n: unknown) =>
    typeof n === "string"
      ? n.replace(/<[^>]+>/g, "").trim() || undefined
      : Array.isArray(n)
        ? n
            .map((x: { note?: string }) => x.note ?? "")
            .join("\n")
            .trim() || undefined
        : undefined;

  autoUpdater.on("checking-for-update", () => {
    if (state.status !== "available" && state.status !== "ready") set({ status: "checking" });
  });
  autoUpdater.on("update-not-available", () => set({ status: "none" }));
  autoUpdater.on("update-available", (info) =>
    set({ status: "available", version: info.version, notes: notes(info.releaseNotes) }),
  );
  autoUpdater.on("download-progress", (p) =>
    set({ ...state, status: "downloading", percent: Math.round(p.percent) }),
  );
  autoUpdater.on("update-downloaded", (info) => {
    set({ status: "ready", version: info.version, notes: notes(info.releaseNotes) });
    if (installing) autoUpdater.quitAndInstall(false, true);
  });
  autoUpdater.on("error", (err) => {
    installing = false;
    // an offline check is not worth showing; a failed download the editor asked for is
    if (state.status === "downloading")
      set({ ...state, status: "error", error: firstLine(err?.message ?? err) });
    else o.log(`update check failed: ${firstLine(err?.message ?? err)}`);
  });

  const check = () => void autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 10_000);
  setInterval(check, SIX_HOURS);

  return {
    state: () => state,
    install: () => {
      if (installing) return;
      if (state.status === "ready") {
        autoUpdater.quitAndInstall(false, true);
        return;
      }
      if (state.status !== "available" && state.status !== "error") return;
      installing = true;
      set({ status: "downloading", version: state.version, notes: state.notes, percent: 0 });
      autoUpdater.downloadUpdate().catch(() => {});
    },
  };
}
