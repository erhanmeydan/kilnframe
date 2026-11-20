import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_PROMO_CAMPAIGN,
  DESKTOP_PROMO_URLS,
  desktopPromoBar,
  desktopPromoUrl,
  dismissDesktopPromo,
  setDesktopPromo,
  showsDesktopPromo,
} from "../src/desktop-promo";
import { setLang } from "../src/i18n";

afterEach(() => {
  setLang("tr");
  vi.unstubAllGlobals();
});

describe("Kilnframe Desktop line", () => {
  it("speaks the panel's language and links to that language's page", () => {
    setLang("tr");
    const tr = desktopPromoBar();
    expect(tr).toContain(
      "Kilnframe Desktop: kaydını konuşarak kurgula, animasyonları kendisi yazsın.",
    );
    expect(tr).toContain("İncele");
    expect(tr).toContain('data-val="https://kilnframe.com/tr/#haber"');
    expect(tr).toContain('aria-label="Kapat"');

    setLang("en");
    const en = desktopPromoBar();
    expect(en).toContain(
      "Kilnframe Desktop: edit your recording by talking, and let it write the animations.",
    );
    expect(en).toContain("Take a look");
    expect(en).toContain('data-val="https://kilnframe.com/#notify"');
    expect(en).toContain('aria-label="Dismiss"');
  });

  it("keeps both links in one place", () => {
    expect(DESKTOP_PROMO_URLS).toEqual({
      tr: "https://kilnframe.com/tr/#haber",
      en: "https://kilnframe.com/#notify",
    });
    expect(desktopPromoUrl("tr")).toBe(DESKTOP_PROMO_URLS.tr);
    expect(desktopPromoUrl("en")).toBe(DESKTOP_PROMO_URLS.en);
  });

  it("opens the page through the panel's open-url action and reaches link and × with the keyboard", () => {
    const bar = desktopPromoBar("en");
    expect(bar).toMatch(/data-act="open-url"[^>]*tabindex="0"/);
    expect(bar).toMatch(/data-act="promo-dismiss"[^>]*role="button"[^>]*tabindex="0"/);
  });

  it("shows by default", () => {
    expect(showsDesktopPromo({})).toBe(true);
  });

  it("stays hidden after × until the campaign number goes up, then shows once", () => {
    const closed = dismissDesktopPromo({ provider: "auto" });
    expect(closed.provider).toBe("auto");
    expect(showsDesktopPromo(closed)).toBe(false);
    // saved and read back, as the panel's settings are
    const saved = JSON.parse(JSON.stringify(closed));
    expect(showsDesktopPromo(saved)).toBe(false);
    // a new campaign shows once more; closing it again hides it again
    const next = DESKTOP_PROMO_CAMPAIGN + 1;
    expect(showsDesktopPromo(saved, next)).toBe(true);
    expect(showsDesktopPromo(dismissDesktopPromo(saved, next), next)).toBe(false);
  });

  it("never shows when turned off in the settings, whatever the campaign", () => {
    const off = setDesktopPromo({}, "off");
    expect(showsDesktopPromo(off)).toBe(false);
    expect(showsDesktopPromo(off, DESKTOP_PROMO_CAMPAIGN + 5)).toBe(false);
  });

  it("brings back a closed line when the settings say Show", () => {
    const on = setDesktopPromo(dismissDesktopPromo({}), "on");
    expect(showsDesktopPromo(on)).toBe(true);
    expect(JSON.parse(JSON.stringify(on))).toEqual({ desktopPromo: "on" });
  });

  it("makes no network request", () => {
    const fetch = vi.fn();
    const xhr = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("XMLHttpRequest", xhr);
    for (const l of ["tr", "en"] as const) {
      setLang(l);
      desktopPromoBar();
      showsDesktopPromo(dismissDesktopPromo(setDesktopPromo({}, "on")));
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(xhr).not.toHaveBeenCalled();
    // nothing in it can load: no images, frames, scripts or requests, only a link the editor clicks
    const source = readFileSync(join(__dirname, "..", "src", "desktop-promo.ts"), "utf8");
    expect(source).not.toMatch(
      /fetch|XMLHttpRequest|sendBeacon|WebSocket|session\.|<img|<iframe|src=/,
    );
    expect(desktopPromoBar("en")).not.toMatch(/<img|<iframe|<script|src=/);
  });
});
