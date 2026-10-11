// Turns the core pipeline's progress lines into the panel's seven steps (packages/core/src/stages/*.ts).

import { t, type MessageKey } from "./i18n";

/** The seven step labels, done and running, in the panel language. */
export function stepLabel(step: number, running: boolean): string {
  return t(`${running ? "running" : "step"}.${step}` as MessageKey);
}
export const STEP_COUNT = 7;

const RULES: [RegExp, number][] = [
  [
    /^(Cutting audio|Decoding audio|Loading speech model|Downloading speech model|Detecting language|Language:|Transcribing|Words from the script)/,
    0,
  ],
  [/^(Planning scenes|Plan:)/, 1],
  [/^Compos(ing|ed)/, 2],
  [/^(Validating|Locating|Repairing|Repair of)/, 3],
  [/^Rendering stills/, 4],
  [/^(Rendering video|Encoding delivery|Synthesizing sound|Building preview)/, 5],
];

/** The step a progress line belongs to, or null for lines that do not move the steps. */
export function stepOf(message: string): number | null {
  for (const [re, step] of RULES) if (re.test(message)) return step;
  return null;
}

/** How far a step is inside itself, 0 to 1, when its lines say so ("Composed s2 (3/6)"). */
export function subProgress(message: string): number | null {
  const m = /^Composed s\d+ \((\d+)\/(\d+)\)/.exec(message);
  return m ? Number(m[1]) / Math.max(1, Number(m[2])) : null;
}

export interface PlannedScene {
  id: string;
  technique: string;
}

/** "Plan: 3 scene(s): s1 three-3d, s2 diagram, s3 code" -> scenes. */
export function parsePlanLine(message: string): PlannedScene[] | null {
  const m = /^Plan: \d+ scene\(s\): (.+)$/.exec(message);
  if (!m?.[1]) return null;
  return m[1].split(/,\s*/).map((part) => {
    const [id = "", technique = ""] = part.trim().split(/\s+/);
    return { id, technique };
  });
}

const TECHNIQUES = new Set([
  "three-3d",
  "motion-2d",
  "kinetic-type",
  "svg-draw",
  "data-viz",
  "diagram",
  "ui-mockup",
  "code",
  "particles",
  "canvas-draw",
  "lottie",
  "map",
  "shader",
  "footage",
  "catalog-block",
]);

export function techniqueName(technique: string): string {
  return TECHNIQUES.has(technique) ? t(`technique.${technique}` as MessageKey) : technique;
}

/** "s3" -> "Scene 3" / "Sahne 3". */
export function sceneName(id: string): string {
  const n = /^s(\d+)$/.exec(id)?.[1];
  return n ? t("scene.name", { n }) : id;
}

/** "Redo Scene 3" / "Sahne 3'ü Yeniden Üret". */
export function redoSceneLabel(id: string): string {
  const n = /^s(\d+)$/.exec(id)?.[1] ?? id;
  return t("scene.redoThis", { n, sceneAcc: sceneAccusative(id) });
}

const SPOKEN = new Set(["tr", "en", "de", "fr", "es"]);

/** A short line for the status under the progress bar, in the panel language, or null to keep the last one. */
export function detailOf(message: string): string | null {
  let m: RegExpExecArray | null;
  if ((m = /^Downloading speech model: (\d+)%/.exec(message)))
    return t("detail.downloadModel", { p: m[1] ?? "" });
  if ((m = /^Language: (\w+)/.exec(message))) {
    const code = m[1] ?? "";
    return t("detail.language", {
      name: SPOKEN.has(code) ? t(`lang.${code}` as MessageKey) : code,
    });
  }
  if (
    /^(Decoding audio|Cutting audio|Transcribing|Loading speech model|Detecting language)/.test(
      message,
    )
  )
    return t("detail.transcribing");
  if ((m = /^Reading aloud (\d+)\/(\d+)/.exec(message)))
    return t("detail.readingAloud", { n: m[1] ?? "", m: m[2] ?? "" });
  if (/^Writing the story/.test(message)) return t("story.writing");
  if ((m = /^Words from the script: (\d+)/.exec(message)))
    return t("detail.scriptWords", { n: m[1] ?? "" });
  if (/^Writing the music/.test(message)) return t("story.musicWriting");
  if (/^Mixing the music/.test(message)) return t("story.musicMixing");
  if (/^Writing the style \(repair/.test(message)) return t("detail.styleRepair");
  if (/^Writing the style/.test(message)) return t("detail.styleWriting");
  if (/^Style written/.test(message)) return t("detail.styleWritten");
  if (/^Composing \d+ sample scene/.test(message)) return t("detail.sampleScenes");
  if (/^Planning scenes \(repair/.test(message)) return t("detail.planRepair");
  if (/^Planning scenes/.test(message)) return t("detail.planning");
  if ((m = /^Plan: (\d+) scene/.exec(message))) return t("detail.planned", { n: m[1] ?? "" });
  if ((m = /^Composing (\d+) scene/.exec(message))) return t("detail.composing", { n: m[1] ?? "" });
  if ((m = /^Composed s\d+ \((\d+)\/(\d+)\)/.exec(message)))
    return t("detail.composed", { done: m[1] ?? "", n: m[2] ?? "" });
  if ((m = /^Validating after repair round (\d+)/.exec(message)))
    return t("detail.validatingRound", { n: m[1] ?? "" });
  if (/^Validating/.test(message)) return t("detail.validating");
  if (/^Locating/.test(message)) return t("detail.locating");
  if ((m = /^Repairing (.+)$/.exec(message))) {
    const ids = [...(m[1] ?? "").matchAll(/\bs(\d+)\b/g)].map((x) => x[1]);
    return ids.length
      ? t("detail.repairingScenes", { ids: ids.join(", ") })
      : t("detail.repairing");
  }
  if (/^Rendering stills/.test(message)) return t("detail.stills");
  if (/^Rendering video/.test(message)) return t("detail.video");
  if (/^Encoding delivery/.test(message)) return t("detail.encoding");
  if (/^Synthesizing sound/.test(message)) return t("detail.sfx");
  if (/^Building preview/.test(message)) return t("detail.preview");
  return null;
}

const UNITS = ["", "i", "yi", "ü", "ü", "i", "yı", "yi", "i", "u"];
const TENS = ["", "u", "yi", "u", "ı", "yi", "ı", "i", "i", "ı"];

/** Turkish only: "Sahne 4" in the accusative, as Turkish reads the number: 1'i, 2'yi, 3'ü, 6'yı, 10'u, 20'yi, 40'ı. */
export function sceneAccusative(id: string): string {
  const n = Number(/^s(\d+)$/.exec(id)?.[1] ?? NaN);
  if (!Number.isInteger(n) || n <= 0) return id;
  const suffix = n % 10 ? UNITS[n % 10] : n % 100 ? TENS[(n % 100) / 10] : "ü";
  return `Sahne ${n}'${suffix}`;
}
