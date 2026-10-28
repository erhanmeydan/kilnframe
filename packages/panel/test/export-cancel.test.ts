import { afterEach, describe, expect, it } from "vitest";
import { exportError } from "../src/export-cancel";
import { setLang, t } from "../src/i18n";

afterEach(() => setLang("en"));

describe("exportError", () => {
  it("says a cancelled Premiere export in the panel's language", () => {
    setLang("tr");
    const e = exportError(new Error("User has cancelled the export"));
    expect(e.message).toBe(t("export.cancelled"));
    expect(e.message).toMatch(/iptal/);
  });
  it("leaves other export errors as they are", () => {
    const err = new Error("Disk full");
    expect(exportError(err)).toBe(err);
  });
});
