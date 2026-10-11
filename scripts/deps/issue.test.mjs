import { describe, expect, it } from "vitest";
import { parseAudit } from "./audit.mjs";
import { issueBody, modelChanges, sameContent } from "./issue.mjs";

const dep = (id, group, current) => ({
  id,
  group,
  current,
  source: { type: "npm", package: id },
  files: [],
});
const now = new Date("2026-10-19T06:00:00Z");
const results = [
  { dep: dep("hyperframes", "render", "0.8.133"), latest: "0.8.140", notes: "https://n" },
  { dep: dep("ffmpeg-mac", "render", "1789931890_9.0.2"), error: "HTTP 503" },
  { dep: dep("electron", "app", "44.7.0"), latest: "44.7.0" },
  { dep: dep("typescript", "dev", "6.0.3"), latest: "6.1.0" },
];

describe("issue body", () => {
  it("groups updates, lists what could not be checked, summarises dev tools in one line", () => {
    const body = issueBody(results, [], null, now);
    expect(body).toContain("Son kontrol: 2026-10-19 06:00 UTC");
    expect(body).toContain("- [ ] **hyperframes** 0.8.133 → 0.8.140 (yama) · [notlar](https://n)");
    expect(body).toContain("Kontrol edilemedi: ffmpeg-mac (HTTP 503)");
    expect(body).not.toContain("electron");
    expect(body).toMatch(/## Geliştirici araçları\ntypescript 6\.0\.3 → 6\.1\.0/);
    expect(body).not.toMatch(/[—–]/);
  });
  it("says when a dependency comes with another one", () => {
    const chrome = {
      ...dep("chrome-headless-shell", "render", "152.0.7977.30"),
      follows: "hyperframes",
    };
    const body = issueBody([{ dep: chrome, latest: "155.0.8059.39" }], [], null, now);
    expect(body).toContain("· hyperframes ile gelir");
  });
  it("keeps the boxes Erhan ticked", () => {
    const before = issueBody(results, [], null, now).replace(
      "- [ ] **hyperframes**",
      "- [x] **hyperframes**",
    );
    const after = issueBody(results, [], before, new Date("2026-10-26T06:00:00Z"));
    expect(after).toContain("- [x] **hyperframes** 0.8.133 → 0.8.140");
  });
  it("puts advisories first", () => {
    const adv = parseAudit(
      JSON.stringify({
        advisories: {
          1: {
            module_name: "electron",
            severity: "high",
            title: "RCE",
            url: "https://gh/a",
            patched_versions: ">=44.7.3",
          },
        },
      }),
    );
    const body = issueBody(results, adv, null, now);
    expect(body.indexOf("## Güvenlik")).toBeLessThan(body.indexOf("## Render"));
    expect(body).toContain(
      "- [ ] **electron**: RCE (yüksek), düzeltildi: >=44.7.3 · [ayrıntı](https://gh/a)",
    );
  });
  it("sees no change when only the date or ticks differ", () => {
    const a = issueBody(results, [], null, now);
    const b = issueBody(results, [], null, new Date("2026-10-26T06:00:00Z")).replace(
      "- [ ]",
      "- [x]",
    );
    expect(sameContent(a, b)).toBe(true);
    expect(sameContent(a, issueBody(results.slice(1), [], null, now))).toBe(false);
  });
});

describe("models", () => {
  it("reports vision models added and removed since last week, and a removed suggested model", () => {
    expect(modelChanges(["a", "b"], ["b", "c"])).toEqual({ added: ["c"], removed: ["a"] });
    const body = issueBody(
      [
        {
          dep: {
            id: "openrouter-models",
            group: "app",
            current: "-",
            source: { type: "openrouter-models" },
            files: [],
          },
          latest: "2",
          extra: { visionModels: ["b", "c"], suggested: ["a"] },
        },
      ],
      [],
      "<!-- openrouter: a,b -->",
      now,
    );
    expect(body).toContain("yeni: c");
    expect(body).toContain("kalkan: a (önerilen)");
    expect(body).toContain("<!-- openrouter: b,c -->");
  });
});
