import { describe, expect, it } from "vitest";
import en from "../src/locales/en.json";
import tr from "../src/locales/tr.json";
import { lmStudioDefault, lmStudioRows, type ServedModel } from "../src/models";

const served: ServedModel[] = [
  { id: "a", displayName: "A", contextWindow: 131_072, vision: true, loaded: false },
  { id: "text", displayName: "Text", contextWindow: 32_768, vision: false, loaded: true },
  {
    id: "qwen",
    displayName: "Qwen",
    contextWindow: 262_144,
    vision: true,
    loaded: true,
    loadedContext: 38_000,
    reasons: true,
  },
  { id: "b", displayName: "B", contextWindow: null, vision: true },
];

describe("LM Studio's model picker", () => {
  it("lists loaded models that read images first, with their loaded context", () => {
    expect(lmStudioRows(served, "Loaded")).toEqual([
      { id: "qwen", info: "Loaded · 38K", loaded: true },
      { id: "a", info: "131K", loaded: false },
      { id: "b", info: "", loaded: false },
    ]);
  });

  it("falls back to the max context for a loaded model without one", () => {
    expect(
      lmStudioRows(
        [{ id: "q", displayName: "Q", contextWindow: 262_144, vision: true, loaded: true }],
        "Yüklü",
      ),
    ).toEqual([{ id: "q", info: "Yüklü · 262K", loaded: true }]);
  });

  it("picks a loaded model that reads images by default", () => {
    expect(lmStudioDefault(served)).toBe("qwen");
    expect(lmStudioDefault(served.filter((m) => !m.loaded))).toBe("a");
    expect(lmStudioDefault([])).toBe("");
  });

  it("has the picker and thinking strings in both languages, without dashes in Turkish", () => {
    for (const key of [
      "prov.lmLoaded",
      "prov.lmLoadsOnChoice",
      "prov.thinking",
      "prov.thinkingOff",
      "prov.thinkingOn",
      "prov.thinkingNote",
    ] as const) {
      expect(en[key]).toBeTruthy();
      expect(tr[key]).toBeTruthy();
      expect(tr[key]).not.toMatch(/[–—]/);
    }
    expect([en["prov.thinkingOff"], en["prov.thinkingOn"]]).toEqual(["Off", "On"]);
    expect([tr["prov.thinking"], tr["prov.thinkingOff"], tr["prov.thinkingOn"]]).toEqual([
      "Düşünme",
      "Kapalı",
      "Açık",
    ]);
  });
});
