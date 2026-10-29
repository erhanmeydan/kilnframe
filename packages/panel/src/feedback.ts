// Feedback through the site's feedback page: the panel opens it in the browser with the versions (and an
// error) after the "#", which browsers never send to a server. The page offers Gmail, Outlook, the mail app
// and a copy button, so it works whatever handles mail links on the computer. A reported error carries its
// text only; the user's name is taken out of paths.

import type { MessageKey } from "./i18n";

export const FEEDBACK_PAGE = "https://kilnframe.com/feedback/";

/** Windows opens links through a call that refuses very long ones; the whole link stays well below. */
const MAX_URL = 1800;

export interface FeedbackInfo {
  app: string;
  panel: string;
  editor: "Premiere" | "DaVinci Resolve";
  os: "mac" | "win";
  /** The panel's language: the page speaks it too. */
  lang: "en" | "tr";
  /** Who does the animation work ("Google Gemini · gemini-3.8-flash"); never a key or an address. */
  ai?: string;
}

/** A path's home folder as "~": "/Users/ayse/x" -> "~/x", "C:\Users\Ayse Y\x" -> "~\x". */
export function withoutUserName(text: string): string {
  return text.replace(/\/(?:Users|home)\/[^/\s]+/g, "~").replace(/[A-Za-z]:\\Users\\[^\\]+/g, "~");
}

/** Messages that are the editor's own doing (a stop, an empty field, an old Premiere): no report link. */
export const NOT_REPORTED = [
  "job.stopped",
  "story.needBrief",
  "story.badLength",
  "story.ownEmpty",
  "story.ownTooLong",
  "export.cancelled",
  "premiere.tooOld",
] as const satisfies readonly MessageKey[];

/** Whether an error is worth a report: not the editor's own stop, not a field they left empty. */
export function shouldReport(error: string, own: string[]): boolean {
  // a tab may wrap the message in its own sentence ("The story could not be made: …")
  return !own.some((o) => error.includes(o));
}

export function feedbackPage(
  o: (FeedbackInfo & { kind: "feedback" }) | (FeedbackInfo & { kind: "error"; error: string }),
): string {
  const about = `Kilnframe ${o.app} · Panel ${o.panel} · ${o.editor} · ${o.os === "mac" ? "macOS" : "Windows"}${o.ai ? ` · ${o.ai}` : ""}`;
  const link = (error?: string) => {
    const p = new URLSearchParams({ l: o.lang, k: o.kind, v: about });
    if (error !== undefined) p.set("e", error);
    // spaces as %20, not "+": the page reads them back with URLSearchParams either way
    return `${FEEDBACK_PAGE}#${p.toString().replace(/\+/g, "%20")}`;
  };
  if (o.kind === "feedback") return link();
  // the error is shortened until the link fits; the versions always stay
  let error = withoutUserName(o.error);
  let url = link(error);
  while (url.length > MAX_URL && error.length) {
    error = error.slice(0, Math.floor(error.length * 0.9));
    url = link(`${error}…`);
  }
  return url;
}
