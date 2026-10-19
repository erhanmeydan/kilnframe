import { describe, expect, it } from "vitest";
import { FEEDBACK_ADDRESS, feedbackMail, shouldReport, withoutUserName } from "../src/feedback";

const parse = (url: string) => {
  const [to, query] = url.replace(/^mailto:/, "").split("?");
  const p = new URLSearchParams(query!.replace(/\+/g, "%2B"));
  return { to, subject: p.get("subject")!, body: p.get("body")! };
};

const info = { app: "0.2.3", panel: "0.2.3", editor: "Premiere" as const, os: "mac" as const };

describe("feedback mail", () => {
  it("opens a mail to the feedback address with the versions filled in", () => {
    const m = parse(feedbackMail({ kind: "feedback", ...info }));
    expect(m.to).toBe(FEEDBACK_ADDRESS);
    expect(m.subject).toBe("Kilnframe feedback");
    expect(m.body).toContain("Kilnframe 0.2.3 · Panel 0.2.3 · Premiere · macOS");
  });

  it("carries the error, without the user's name in paths", () => {
    const m = parse(
      feedbackMail({
        kind: "error",
        error: "Could not read /Users/ayse/Movies/Kilnframe/job/plan.json",
        ...info,
        editor: "DaVinci Resolve",
        os: "win",
      }),
    );
    expect(m.subject).toBe("Kilnframe error");
    expect(m.body).toContain("Could not read ~/Movies/Kilnframe/job/plan.json");
    expect(m.body).not.toContain("ayse");
    expect(m.body).toContain("DaVinci Resolve · Windows");
  });

  it("asks in the panel's language", () => {
    const m = parse(feedbackMail({ kind: "error", error: "x", ask: "Ne yapıyordunuz?", ...info }));
    expect(m.body.startsWith("Ne yapıyordunuz?")).toBe(true);
  });

  it("keeps spaces, line breaks and Turkish letters intact", () => {
    const m = parse(
      feedbackMail({ kind: "error", error: "Sahne 2 çizilemedi.\nİkinci satır & %", ...info }),
    );
    expect(m.body).toContain("Sahne 2 çizilemedi.\nİkinci satır & %");
  });

  it("keeps the link short enough for Windows mail apps, versions first", () => {
    const error = "Sahne çizilemedi; işlem yarıda kaldı.\n".repeat(400);
    const url = feedbackMail({ kind: "error", error, ...info });
    expect(url.length).toBeLessThanOrEqual(1800);
    const m = parse(url);
    expect(m.body).toContain("Kilnframe 0.2.3 · Panel 0.2.3");
    expect(m.body.indexOf("Kilnframe 0.2.3")).toBeLessThan(m.body.indexOf("Sahne"));
  });

  it("does not offer a report for the editor's own stop or a missing input", () => {
    const own = ["The job was stopped.", "Write a topic first."];
    expect(shouldReport("The job was stopped.", own)).toBe(false);
    expect(shouldReport("Write a topic first.", own)).toBe(false);
    expect(shouldReport("Lyria failed", own)).toBe(true);
  });
});

describe("withoutUserName", () => {
  it("replaces the home folder on macOS and Windows", () => {
    expect(withoutUserName("/Users/erhan/Desktop/a.wav")).toBe("~/Desktop/a.wav");
    expect(withoutUserName("C:\\Users\\Erhan Meydan\\Videos\\a.wav")).toBe("~\\Videos\\a.wav");
    expect(withoutUserName("/home/ali/x")).toBe("~/x");
    expect(withoutUserName("no path here")).toBe("no path here");
  });
});
