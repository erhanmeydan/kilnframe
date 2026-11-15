import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPalette } from "../src/stages/sfx.js";
import { loadStyle, styleHome, stylesDir, userStylesDir } from "../src/styles.js";

describe("a project's own copies of the editor's styles", () => {
  const before = process.env.KILNFRAME_PROJECT_STYLES_DIR;
  afterEach(() => {
    if (before === undefined) delete process.env.KILNFRAME_PROJECT_STYLES_DIR;
    else process.env.KILNFRAME_PROJECT_STYLES_DIR = before;
  });

  it("are found first, so a style missing from the editor's library still loads, with its sounds", () => {
    const project = mkdtempSync(join(tmpdir(), "kf-project-styles-"));
    // an editor's style that exists only in the project (deleted from the library, or made on another computer)
    cpSync(join(stylesDir(), "gazete-editoryal"), join(project, "gece-kagidi"), { recursive: true });
    expect(styleHome("gece-kagidi")).toBeNull();
    process.env.KILNFRAME_PROJECT_STYLES_DIR = project;
    expect(styleHome("gece-kagidi")).toBe(project);
    const style = loadStyle("gece-kagidi");
    expect(style.custom).toBe(true);
    expect(style.styleMd.length).toBeGreaterThan(100);
    expect(Object.keys(loadPalette("gece-kagidi").sounds).length).toBeGreaterThan(0);
    // a shipped style is still the shipped one, and the user's library is still looked in
    expect(styleHome("kil-lacivert")).toBe(stylesDir());
    expect(userStylesDir()).not.toBe(project);
    rmSync(project, { recursive: true, force: true });
  });
});
