import { describe, expect, it } from "vitest";
import {
  FEEDBACK_PAGE,
  NOT_REPORTED,
  feedbackPage,
  shouldReport,
  withoutUserName,
} from "../src/feedback";

/** The fields a feedback link carries after the "#", as the page reads them. */
const fields = (url: string) => {
  const [page, hash] = url.split("#");
  return { page, ...Object.fromEntries(new URLSearchParams(hash)) } as Record<string, string>;
};

const info = { app: "0.2.3", panel: "0.2.3", editor: "Premiere" as const, os: "mac" as const };

describe("feedback page link", () => {
  it("opens the site's feedback page with the versions and the panel's language", () => {
    const f = fields(feedbackPage({ kind: "feedback", lang: "tr", ...info }));
    expect(f.page).toBe(FEEDBACK_PAGE);
    expect(FEEDBACK_PAGE).toBe("https://kilnframe.com/feedback/");
    expect(f.k).toBe("feedback");
    expect(f.l).toBe("tr");
    expect(f.v).toBe("Kilnframe 0.2.3 · Panel 0.2.3 · Premiere · macOS");
    expect(f.e).toBeUndefined();
  });

  it("carries the error after the #, never to a server, without the user's name in paths", () => {
    const url = feedbackPage({
      kind: "error",
      error: "Could not read /Users/ayse/Movies/Kilnframe/job/plan.json",
      lang: "en",
      ...info,
      editor: "DaVinci Resolve",
      os: "win",
    });
    expect(url.split("#")[0]).toBe(FEEDBACK_PAGE);
    const f = fields(url);
    expect(f.k).toBe("error");
    expect(f.e).toBe("Could not read ~/Movies/Kilnframe/job/plan.json");
    expect(url).not.toContain("ayse");
    expect(f.v).toContain("DaVinci Resolve · Windows");
  });

  it("names FilmCraft as the editor", () => {
    const f = fields(feedbackPage({ kind: "feedback", lang: "en", ...info, editor: "FilmCraft" }));
    expect(f.v).toContain("FilmCraft · macOS");
  });

  it("names the provider and model that did the work, when given", () => {
    const f = fields(
      feedbackPage({
        kind: "error",
        error: "Bir sahne boş çıktı.",
        lang: "tr",
        ai: "Google Gemini · gemini-3.8-flash",
        ...info,
      }),
    );
    expect(f.v).toBe(
      "Kilnframe 0.2.3 · Panel 0.2.3 · Premiere · macOS · Google Gemini · gemini-3.8-flash",
    );
  });

  it("keeps spaces, line breaks and Turkish letters intact", () => {
    const f = fields(
      feedbackPage({
        kind: "error",
        error: "Sahne 2 çizilemedi.\nİkinci satır & % #",
        lang: "tr",
        ...info,
      }),
    );
    expect(f.e).toBe("Sahne 2 çizilemedi.\nİkinci satır & % #");
  });

  it("keeps the link short enough for Windows to open it, with the versions kept", () => {
    const error = "Sahne çizilemedi; işlem yarıda kaldı.\n".repeat(400);
    const url = feedbackPage({ kind: "error", error, lang: "tr", ...info });
    expect(url.length).toBeLessThanOrEqual(1800);
    expect(fields(url).v).toBe("Kilnframe 0.2.3 · Panel 0.2.3 · Premiere · macOS");
    expect(fields(url).e!.startsWith("Sahne çizilemedi")).toBe(true);
  });

  it("does not offer a report for the editor's own stop or a missing input", () => {
    const own = ["The job was stopped.", "Write a topic first."];
    expect(shouldReport("The job was stopped.", own)).toBe(false);
    expect(shouldReport("Write a topic first.", own)).toBe(false);
    expect(shouldReport("Lyria failed", own)).toBe(true);
  });

  it("does not offer a report when a tab wraps the editor's own stop in its own sentence", () => {
    const own = ["The export was cancelled in Premiere. You can try again."];
    expect(
      shouldReport(
        "The story could not be made: The export was cancelled in Premiere. You can try again.",
        own,
      ),
    ).toBe(false);
  });
});

describe("withoutUserName", () => {
  it("replaces the home folder on macOS and Windows", () => {
    expect(withoutUserName("/Users/erhan/Desktop/a.wav")).toBe("~/Desktop/a.wav");
    expect(withoutUserName("C:\\Users\\Erhan Meydan\\Videos\\a.wav")).toBe("~\\Videos\\a.wav");
    expect(withoutUserName("/home/ali/x")).toBe("~/x");
    expect(withoutUserName("no path here")).toBe("no path here");
  });

  describe("errors that are the editor's own", () => {
    it("include the own text's empty and too long notes", () => {
      expect(NOT_REPORTED).toContain("story.ownEmpty");
      expect(NOT_REPORTED).toContain("story.ownTooLong");
      expect(NOT_REPORTED).toContain("export.cancelled");
    });
  });
});
