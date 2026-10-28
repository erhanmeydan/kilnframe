import { afterEach, describe, expect, it } from "vitest";
import { setLang } from "../src/i18n";
import { premiereCall } from "../src/premiere-version";

afterEach(() => setLang("en"));

describe("premiereCall", () => {
  it("calls the method when this Premiere has it", async () => {
    const settings = { getVideoFrameRate: async () => 25 };
    expect(await premiereCall(settings, "getVideoFrameRate")).toBe(25);
  });
  it("asks for a newer Premiere when the method is missing", async () => {
    setLang("tr");
    await expect(premiereCall({}, "getVideoFrameRate")).rejects.toThrow(/26\.2/);
    await expect(premiereCall({}, "getVideoFrameRate")).rejects.toThrow(/güncelleyin/);
  });
});
