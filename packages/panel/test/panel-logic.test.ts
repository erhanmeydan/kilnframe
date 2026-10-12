import { beforeEach, describe, expect, it } from "vitest";
import en from "../src/locales/en.json";
import tr from "../src/locales/tr.json";
import { localized, pickLang, setLang, t } from "../src/i18n";
import { formatDuration, formatTimecode, pickRange } from "../src/range";
import {
  detailOf,
  parsePlanLine,
  redoSceneLabel,
  sceneName,
  stepLabel,
  stepOf,
  techniqueName,
} from "../src/steps";

// the tests below were written for the Turkish panel; English has its own block at the end
beforeEach(() => setLang("tr"));

describe("range", () => {
  it("uses the in/out range when it is set", () => {
    const r = pickRange(4.96, 15.05, 40.09);
    expect(r).toMatchObject({ startS: 4.96, endS: 15.05, source: "inout", warning: null });
  });

  it("takes the whole sequence when no in/out is set (Premiere returns -400000)", () => {
    const r = pickRange(-400000, -400000, 40.09);
    expect(r).toMatchObject({ startS: 0, endS: 40.09, source: "sequence", warning: null });
  });

  it("says a range over 45 s is made in parts", () => {
    const r = pickRange(-400000, -400000, 75.4);
    expect(r.warning).toBe(
      "Bu aralık 1 dk 15 sn. Cümle sonlarından kesilerek yaklaşık 30 saniyelik parçalar halinde üretilecek.",
    );
    expect(r.durationS).toBeCloseTo(75.4);
  });

  it("formats durations and timecodes", () => {
    expect(formatDuration(9.6)).toBe("10 sn");
    expect(formatDuration(120)).toBe("2 dk");
    expect(formatTimecode(5.04)).toBe("00:05");
    expect(formatTimecode(3725)).toBe("1:02:05");
  });
});

describe("progress steps", () => {
  it("maps the core's progress lines to the panel steps", () => {
    expect(stepOf("Transcribing")).toBe(0);
    expect(stepOf("Plan: 3 scene(s): s1 three-3d, s2 diagram, s3 code")).toBe(1);
    expect(stepOf("Composing 3 scene(s)")).toBe(2);
    expect(stepOf("Repairing s2 (text_occluded)")).toBe(3);
    expect(stepOf("Rendering stills")).toBe(4);
    expect(stepOf("Synthesizing sound effects")).toBe(5);
    expect(stepOf("Downloading speech model: 40%")).toBe(0);
    expect(stepOf("something else")).toBeNull();
  });

  it("reads the plan line and names scenes and techniques in Turkish", () => {
    expect(parsePlanLine("Plan: 2 scene(s): s1 svg-draw, s2 kinetic-type")).toEqual([
      { id: "s1", technique: "svg-draw" },
      { id: "s2", technique: "kinetic-type" },
    ]);
    expect(sceneName("s12")).toBe("Sahne 12");
    expect(techniqueName("data-viz")).toBe("Grafik");
  });
});

describe("status line", () => {
  it("turns core progress lines into short Turkish status text", async () => {
    const { detailOf } = await import("../src/steps");
    expect(detailOf("Language: tr (100%)")).toBe("Dil: Türkçe");
    expect(detailOf("Composing 7 scene(s)")).toBe("7 sahnenin kodu yazılıyor");
    expect(detailOf("Repairing s3 (text_occluded), s7 (content_overlap)")).toBe(
      "Onarılıyor: Sahne 3, 7",
    );
    expect(detailOf("Validating after repair round 2")).toBe("Onarım 2 kontrol ediliyor");
    expect(detailOf("Downloading speech model: 35%")).toBe("Konuşma modeli indiriliyor · %35");
    expect(detailOf("something else")).toBeNull();
  });
});

describe("Turkish accusative for scene numbers", () => {
  it("picks the suffix from how the number is read", async () => {
    const { sceneAccusative } = await import("../src/steps");
    expect(
      ["s1", "s2", "s3", "s4", "s6", "s9", "s10", "s12", "s20", "s40", "s100"].map(sceneAccusative),
    ).toEqual([
      "Sahne 1'i",
      "Sahne 2'yi",
      "Sahne 3'ü",
      "Sahne 4'ü",
      "Sahne 6'yı",
      "Sahne 9'u",
      "Sahne 10'u",
      "Sahne 12'yi",
      "Sahne 20'yi",
      "Sahne 40'ı",
      "Sahne 100'ü",
    ]);
  });
});

describe("panel language", () => {
  it("opens in English unless Premiere runs in Turkish or the editor picks a language", () => {
    expect(pickLang("auto", "en_US")).toBe("en");
    expect(pickLang("auto", "de_DE")).toBe("en");
    expect(pickLang("auto", null)).toBe("en");
    expect(pickLang("auto", "tr_TR")).toBe("tr");
    expect(pickLang("auto", "tr-TR")).toBe("tr");
    expect(pickLang("en", "tr_TR")).toBe("en");
    expect(pickLang("tr", "en_US")).toBe("tr");
  });

  it("keeps both dictionaries in step: same keys, same placeholders, no dashes in Turkish", () => {
    expect(Object.keys(tr).sort()).toEqual(Object.keys(en).sort());
    const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      // the Turkish redo label uses the accusative form instead of the bare number
      if (key === "scene.redoThis") continue;
      expect(holes(tr[key]), key).toEqual(holes(en[key]));
    }
    for (const text of Object.values(tr)) expect(text).not.toMatch(/[\u2013\u2014]/);
  });

  it("speaks English in every helper", () => {
    setLang("en");
    expect(pickRange(-400000, -400000, 75.4).warning).toBe(
      "This range is 1 min 15 s. It will be made in parts of about 30 seconds, cut where a sentence ends.",
    );
    expect(formatDuration(9.6)).toBe("10 s");
    expect(sceneName("s3")).toBe("Scene 3");
    expect(redoSceneLabel("s3")).toBe("Redo Scene 3");
    expect(techniqueName("data-viz")).toBe("Chart");
    expect(stepLabel(4, true)).toBe("Taking Preview Stills");
    expect(detailOf("Language: tr (100%)")).toBe("Language: Turkish");
    expect(detailOf("Repairing s3 (x), s7 (y)")).toBe("Repairing: Scene 3, 7");
    expect(t("home.placed", { v: 6, a: 5 })).toBe("The animation is on the timeline: V6 and A5.");
    expect(localized({ en: "Isometric", tr: "İzometrik" })).toBe("Isometric");
    expect(localized("Old Style")).toBe("Old Style");
  });

  it("uses the Turkish accusative for the redo button", () => {
    expect(redoSceneLabel("s3")).toBe("Sahne 3'ü Yeniden Üret");
    expect(redoSceneLabel("s2")).toBe("Sahne 2'yi Yeniden Üret");
    expect(stepLabel(4, true)).toBe("Önizleme Kareleri Alınıyor");
    expect(localized({ en: "Isometric", tr: "İzometrik" })).toBe("İzometrik");
  });
});

describe("composing progress", () => {
  it("moves the bar and the detail as each scene is written", async () => {
    const { detailOf, stepOf, subProgress } = await import("../src/steps");
    expect(stepOf("Composed s3 (2/6)")).toBe(2);
    expect(subProgress("Composed s3 (2/6)")).toBeCloseTo(1 / 3);
    expect(subProgress("Composing 6 scene(s)")).toBeNull();
    expect(detailOf("Composed s3 (2/6)")).toMatch(/2/);
  });
});

describe("story sequence frame", () => {
  it("keeps the short side and turns the frame", async () => {
    const { frameFor } = await import("../src/frame");
    expect(frameFor("portrait", 1920, 1080)).toEqual({ width: 1080, height: 1920 });
    expect(frameFor("square", 3840, 2160)).toEqual({ width: 2160, height: 2160 });
    expect(frameFor("landscape", 1080, 1920)).toEqual({ width: 1920, height: 1080 });
  });
});

describe("story length typed by the editor", () => {
  it("reads seconds, minutes:seconds and words", async () => {
    const { parseLength } = await import("../src/range");
    expect(parseLength("45")).toBe(45);
    expect(parseLength("1:30")).toBe(90);
    expect(parseLength(" 2 dk ")).toBe(120);
    expect(parseLength("1,5 dakika")).toBe(90);
    expect(parseLength("90 sn")).toBe(90);
    expect(parseLength("3 min")).toBe(180);
    expect(parseLength("1:75")).toBeNull();
    expect(parseLength("bir dakika")).toBeNull();
  });
});

describe("frames of the footage for automatic mode", () => {
  it("takes three frames of a short range and one per 20 s of a long one", async () => {
    const { footageFrameTimes } = await import("../src/range");
    expect(footageFrameTimes({ startS: 10, durationS: 10 })).toEqual([11.5, 15, 18.5]);
    expect(footageFrameTimes({ startS: 0, durationS: 100 })).toHaveLength(5);
    expect(footageFrameTimes({ startS: 0, durationS: 600 })).toHaveLength(6);
  });

  it("gives each part the frames inside it, or the nearest one", async () => {
    const { framesForRange } = await import("../src/range");
    const frames = [5, 25, 45].map((seqS, i) => ({ path: `/f${i + 1}.png`, seqS }));
    expect(framesForRange(frames, 20, 50)).toEqual([
      { path: "/f2.png", atS: 5 },
      { path: "/f3.png", atS: 25 },
    ]);
    expect(framesForRange(frames, 50, 80)).toEqual([{ path: "/f3.png", atS: 0 }]);
    expect(framesForRange([], 0, 10)).toEqual([]);
  });
});

describe("model names under the button", () => {
  it("reads model ids as names", async () => {
    const { prettyModel } = await import("../src/models");
    expect(prettyModel("grok-4.7")).toBe("Grok 4.7");
    expect(prettyModel("gpt-6.1-sol")).toBe("GPT 6.1 Sol");
    expect(prettyModel("MiniMax-M3")).toBe("MiniMax M3");
    expect(prettyModel("gemini-3.1-pro-preview")).toBe("Gemini 3.1 Pro Preview");
    expect(prettyModel("anthropic/claude-opus-5.5")).toBe("Claude Opus 5.5");
  });
});

describe("earlier inserts on the timeline", () => {
  it("knows our own files by their job folder", async () => {
    const { isOurInsert } = await import("../src/our-files");
    expect(isOurInsert("/Projects/Film/Kilnframe/Sekans-1-20261009/insert.mov")).toBe(true);
    expect(isOurInsert("C:\\Projects\\Film\\Kilnframe\\Seq\\sfx_mix.wav")).toBe(true);
    expect(isOurInsert("/Projects/Film/Motion Inserts/old/insert.mp4")).toBe(true);
    // the companion's own job folder when the project has none (and every job of the 0.1.x companions)
    expect(isOurInsert("/Users/e/.kilnframe/jobs/Timeline-1-20261012-115531/insert.mp4")).toBe(
      true,
    );
    expect(isOurInsert("C:\\Users\\e\\.kilnframe\\jobs\\Seq\\sfx_mix.wav")).toBe(true);
    expect(isOurInsert("/Footage/orjinal-1.mp4")).toBe(false);
    expect(isOurInsert("/Footage/Kilnframe-logo.png")).toBe(false);
  });
  it("leaves the editor's own media alone even inside a folder named Kilnframe", async () => {
    const { isOurInsert } = await import("../src/our-files");
    // a project folder called Kilnframe, or footage copied out of a job folder (the Resolve test, 12 Oct 2026)
    expect(isOurInsert("/Users/e/Videos/Kilnframe/footage.mp4")).toBe(false);
    expect(isOurInsert("/out/Kilnframe/orjinal-1-20261011-191201/footage.mp4")).toBe(false);
    expect(isOurInsert("/Projects/Kilnframe/interview.mov")).toBe(false);
    expect(isOurInsert("/Projects/Film/Kilnframe/Seq/sfx_stems/01-whoosh.wav")).toBe(true);
    expect(isOurInsert("/Users/e/Movies/Kilnframe/Belgesel/Timeline-1-20261012/insert.mov")).toBe(
      true,
    );
  });
});
