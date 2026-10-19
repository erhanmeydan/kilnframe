// Feedback by mail: no account and no form, the editor's own mail app opens with the versions filled in. A
// reported error carries its text only; the user's name is taken out of paths, and no file is attached.

export const FEEDBACK_ADDRESS = "hello@kilnframe.com";

/** Mail apps on Windows refuse or cut mailto links much over 2000 characters; the whole link stays below. */
const MAX_URL = 1800;

export interface FeedbackInfo {
  app: string;
  panel: string;
  editor: "Premiere" | "DaVinci Resolve";
  os: "mac" | "win";
  /** The line above the error, in the panel's language. */
  ask?: string;
}

/** A path's home folder as "~": "/Users/ayse/x" -> "~/x", "C:\Users\Ayse Y\x" -> "~\x". */
export function withoutUserName(text: string): string {
  return text.replace(/\/(?:Users|home)\/[^/\s]+/g, "~").replace(/[A-Za-z]:\\Users\\[^\\]+/g, "~");
}

/** Whether an error is worth a report: not the editor's own stop, not a field they left empty. */
export function shouldReport(error: string, own: string[]): boolean {
  return !own.includes(error.trim());
}

export function feedbackMail(
  o: (FeedbackInfo & { kind: "feedback" }) | (FeedbackInfo & { kind: "error"; error: string }),
): string {
  const about = `Kilnframe ${o.app} · Panel ${o.panel} · ${o.editor} · ${o.os === "mac" ? "macOS" : "Windows"}`;
  const subject = o.kind === "error" ? "Kilnframe error" : "Kilnframe feedback";
  const link = (body: string) =>
    `mailto:${FEEDBACK_ADDRESS}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  if (o.kind === "feedback") return link(`\n\n\n---\n${about}`);
  // the versions come before the error, so a cut never takes them; the error is shortened until it fits
  const head = `${o.ask ?? "What were you doing when it happened?"}\n\n\n---\n${about}\n\n`;
  let error = withoutUserName(o.error);
  let url = link(head + error);
  while (url.length > MAX_URL && error.length) {
    error = error.slice(0, Math.floor(error.length * 0.9));
    url = link(`${head}${error}…`);
  }
  return url;
}
