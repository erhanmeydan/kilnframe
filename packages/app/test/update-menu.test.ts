import { describe, expect, it } from "vitest";
import { afterDownload, updateMenuLine } from "../src/update-menu.js";

const text = {
  updateNow: "Update Now ({v})",
  updateBusy: "Version {v} is ready. Update when the animation is done.",
  updateDownloading: "Downloading the update… {p}%",
  updateRestarting: "Installing…",
};
const at = (status: string, more = {}) =>
  ({ status, current: "0.4.0", version: "0.4.1", ...more }) as never;

describe("updateMenuLine", () => {
  it("shows nothing without an update", () => {
    expect(updateMenuLine(null, false, text)).toBeNull();
    expect(updateMenuLine(at("none"), false, text)).toBeNull();
    expect(updateMenuLine(at("checking"), false, text)).toBeNull();
  });

  it("offers Update Now for a new version, and again after a failed download", () => {
    expect(updateMenuLine(at("available"), false, text)).toEqual({
      label: "Update Now (0.4.1)",
      install: true,
    });
    expect(updateMenuLine(at("error"), false, text)?.install).toBe(true);
  });

  it("only tells the version while a job runs: installing would end the job", () => {
    expect(updateMenuLine(at("available"), true, text)).toEqual({
      label: "Version 0.4.1 is ready. Update when the animation is done.",
      install: false,
    });
  });

  it("shows the download and the install as notes, not as buttons", () => {
    expect(updateMenuLine(at("downloading", { percent: 42 }), false, text)).toEqual({
      label: "Downloading the update… 42%",
      install: false,
    });
    expect(updateMenuLine(at("ready"), false, text)).toEqual({
      label: "Installing…",
      install: false,
    });
  });
});

describe("afterDownload", () => {
  it("installs a download the editor asked for, unless a job started meanwhile", () => {
    expect(afterDownload(true, false)).toBe("install");
    // installing would quit the app and end the job: the update is offered again instead
    expect(afterDownload(true, true)).toBe("offer");
    expect(afterDownload(false, false)).toBe("offer");
  });
});
