// The update line in the menu bar (system tray) menu: the update starts from there with one click, as
// from the panel's Update button, unless a job is running (installing quits the app and the job with it).
import type { AppUpdateState } from "@kilnframe/companion";

export interface UpdateMenuText {
  /** "Update Now ({v})" */
  updateNow: string;
  /** "Version {v} is ready. Update when the animation is done." */
  updateBusy: string;
  /** "Downloading the update… {p}%" */
  updateDownloading: string;
  updateRestarting: string;
}

/**
 * A finished download: installed when the editor asked for it and no job runs. A job may have started while
 * it downloaded; installing would quit the app and end that job, so the update is offered again instead
 * ("ready" would read as "Installing…" in the menu and the panel).
 */
export function afterDownload(installing: boolean, busy: boolean): "install" | "offer" {
  return installing && !busy ? "install" : "offer";
}

/** The menu's update line, or null when there is no update; `install` makes it clickable. */
export function updateMenuLine(
  state: AppUpdateState | null,
  busy: boolean,
  text: UpdateMenuText,
): { label: string; install: boolean } | null {
  if (!state) return null;
  const v = state.version ?? "";
  switch (state.status) {
    case "available":
    case "error":
      return busy
        ? { label: text.updateBusy.replace("{v}", v), install: false }
        : { label: text.updateNow.replace("{v}", v), install: true };
    case "downloading":
      return {
        label: text.updateDownloading.replace("{p}", String(state.percent ?? 0)),
        install: false,
      };
    case "ready":
      return { label: text.updateRestarting, install: false };
    default:
      return null;
  }
}
