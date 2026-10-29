import { t } from "./i18n";

/**
 * Premiere throws "User has cancelled the export" when the editor presses Cancel (or Esc) in its export
 * progress window. That is the editor's own stop, not a fault: it is said in the panel's language and gets no
 * report link. Any other error is passed on as it is.
 */
export function exportError(err: unknown): unknown {
  const message = err instanceof Error ? err.message : String(err);
  return /cancel+ed the export/i.test(message) ? new Error(t("export.cancelled")) : err;
}
