import { z } from "zod";
import { framesToSeconds, parseFps, secondsToFrame, formatFps, type Fps } from "../fps.js";
import { extractJson, loadPrompt } from "../prompts.js";
import type { ChatMessage, TextProvider } from "../providers/types.js";
import type { PreparedAsset } from "../assets.js";
import type { RangeFrame } from "../frames.js";
import { phraseBox, type Box } from "../ocr.js";
import {
  ASSET_ROLES,
  MARK_KINDS,
  OUTPUT_MODES,
  PlanSchema,
  SPEAKER_SIDES,
  TECHNIQUES,
  type OutputFormat,
  type OutputMode,
  type Plan,
} from "../schemas/plan.js";
import type { Transcript } from "../schemas/transcript.js";
import type { StyleInfo } from "../styles.js";

/** What the model returns: seconds, not frames. The code turns it into a frame-exact plan. */
export const PlanDraftSchema = z.object({
  topic: z.string().min(1),
  summary: z.string().min(1),
  /** Automatic mode with frames: where the speaker sits. */
  speaker_side: z.enum(SPEAKER_SIDES).optional(),
  scenes: z
    .array(
      z.object({
        id: z.string(),
        start_s: z.number().nonnegative(),
        end_s: z.number().positive(),
        anchor_words: z.array(z.string()),
        visual: z.string().min(1),
        on_screen_text: z.string().nullable(),
        camera: z.string().min(1),
        technique: z.enum(TECHNIQUES),
        transition_out: z.string().min(1),
        /** Automatic mode: fullscreen or overlay, chosen per scene. */
        mode: z.enum(OUTPUT_MODES).optional(),
        assets: z
          .array(
            z.object({
              id: z.string(),
              role: z.enum(ASSET_ROLES),
              marks: z
                .array(
                  z.object({
                    kind: z.enum(MARK_KINDS),
                    /** A read line of the image, by id ("l3"). */
                    line: z.string().optional(),
                    /** Words inside that line to mark; the whole line when left out. */
                    text: z.string().nullable().optional(),
                    /** For a target without text: x, y, width, height in the image's pixels. */
                    box: z.array(z.number()).length(4).optional(),
                    at_s: z.number(),
                  }),
                )
                .optional()
                .default([]),
            }),
          )
          .optional()
          .default([]),
        sfx: z.array(z.object({ at_s: z.number(), sound: z.string(), gain_db: z.number() })),
      }),
    )
    .min(1),
});
export type PlanDraft = z.infer<typeof PlanDraftSchema>;

export interface PartContext {
  /** 1-based. */
  index: number;
  count: number;
  /** The end of the previous part's speech and the start of the next one's, for continuity. */
  before?: string | undefined;
  after?: string | undefined;
}

/** Tells the model this range is one of several inserts cut from one long passage. */
function partLines(part: PartContext | undefined): string[] {
  if (!part || part.count < 2) return [];
  return [
    `This range is part ${part.index} of ${part.count} of one long passage; each part is its own insert, ` +
      "placed back to back. Keep one visual world across parts: no title card or intro after part 1, " +
      `no closing card before part ${part.count}.`,
    part.before ? `Said just before this part: "…${part.before}"` : null,
    part.after ? `Said just after this part: "${part.after}…"` : null,
  ].filter((l): l is string => l !== null);
}

/** "auto": the plan step picks fullscreen or overlay for each scene. */
export type JobMode = OutputMode | "auto";

export interface PlanJob {
  style: string;
  mode: JobMode;
  format: OutputFormat;
  width: number;
  height: number;
  fps: Fps;
  handlesFrames: number;
  note?: string | undefined;
  /** One part of a long range (parts.ts): which one, and what is said around it. */
  part?: PartContext | undefined;
  /** The editor's images; the model sees their previews and places them in scenes. */
  assets?: PreparedAsset[];
  /** Frames of the footage under the range; the model sees them to place overlays beside the speaker. */
  frames?: RangeFrame[];
}

/**
 * Converts a draft to a plan: scenes become contiguous frame ranges covering the whole insert (each scene
 * starts where the previous one ends), sound cues snap to frames and are clamped into their scene.
 */
export function draftToPlan(draft: PlanDraft, job: PlanJob, durationS: number): Plan {
  const durationFrames = Math.max(1, Math.round((durationS * job.fps.num) / job.fps.den));
  const scenes = [...draft.scenes].sort((a, b) => a.start_s - b.start_s);
  const modes: OutputMode[] = scenes.map((s) =>
    job.mode === "auto" ? (s.mode ?? "fullscreen") : job.mode,
  );
  const ends = scenes.map((s, i) =>
    i === scenes.length - 1
      ? durationFrames
      : Math.min(durationFrames - 1, Math.max(1, secondsToFrame(s.end_s, job.fps))),
  );
  for (let i = 1; i < ends.length; i++)
    ends[i] = Math.max(ends[i] as number, (ends[i - 1] as number) + 1);
  return PlanSchema.parse({
    version: 1,
    topic: draft.topic,
    summary: draft.summary,
    style: job.style,
    // one overlay scene makes the whole insert render with alpha; fullscreen scenes paint their own ground
    mode: modes.includes("overlay") ? "overlay" : "fullscreen",
    speaker: job.frames?.length ? { side: draft.speaker_side ?? "center" } : null,
    format: job.format,
    width: job.width,
    height: job.height,
    fps: formatFps(job.fps),
    duration_frames: durationFrames,
    handles_frames: job.handlesFrames,
    assets: (job.assets ?? []).map(({ preview: _preview, ...info }) => info),
    scenes: scenes.map((s, i) => {
      const start = i === 0 ? 0 : (ends[i - 1] as number);
      const end = ends[i] as number;
      return {
        id: `s${i + 1}`,
        start_frame: start,
        end_frame: end,
        anchor_words: s.anchor_words,
        visual: s.visual,
        on_screen_text: s.on_screen_text,
        camera: s.camera,
        technique: s.technique,
        assets: (s.assets ?? []).map((use) => {
          const asset = job.assets?.find((a) => a.id === use.id);
          return {
            id: use.id,
            role: use.role,
            marks: (use.marks ?? []).flatMap((m) => {
              const r = asset ? resolveMark(m, asset) : null;
              if (!r || typeof r === "string") return [];
              return [
                {
                  kind: m.kind,
                  box: r.box,
                  frame: Math.min(end - 1, Math.max(start, secondsToFrame(m.at_s, job.fps))),
                  text: r.text,
                },
              ];
            }),
          };
        }),
        transition_out: i === scenes.length - 1 ? "cut" : s.transition_out,
        mode: modes[i],
        image_requests: [],
        sfx: s.sfx.map((c) => ({
          frame: Math.min(end - 1, Math.max(start, secondsToFrame(c.at_s, job.fps))),
          type: c.sound,
          gain_db: Math.min(0, c.gain_db),
        })),
      };
    }),
  });
}

type DraftMark = PlanDraft["scenes"][number]["assets"][number]["marks"][number];
type MarkableAsset = Pick<PreparedAsset, "id" | "width" | "height" | "lines">;

/** The pixel box of a mark: a phrase in a read line, a whole line, or a box the model gave. */
export function resolveMark(
  mark: DraftMark,
  asset: MarkableAsset,
): { box: Box; text: string | null } | string {
  if (mark.line) {
    const line = asset.lines?.find((l) => l.id === mark.line);
    if (!line) return `line "${mark.line}" was not read in ${asset.id}`;
    const box = phraseBox(line, mark.text);
    if (!box)
      return `"${mark.text}" is not in line ${line.id} of ${asset.id} ("${line.text}"); use words exactly as read, or leave text out to mark the whole line`;
    return { box, text: mark.text?.trim() || line.text };
  }
  if (mark.box) {
    const [x, y, w, h] = mark.box as Box;
    if (w <= 0 || h <= 0 || x < 0 || y < 0 || x + w > asset.width || y + h > asset.height)
      return `box [${mark.box.join(", ")}] is outside ${asset.id} (${asset.width}x${asset.height})`;
    return { box: [x, y, w, h], text: null };
  }
  return "a mark needs a line id or a box";
}

/** Problems the code can detect beyond the schema: unsupported techniques, unknown sounds and images. */
export function planProblems(
  draft: PlanDraft,
  style: StyleInfo,
  assets: MarkableAsset[] = [],
  job: Pick<PlanJob, "mode" | "frames"> = { mode: "fullscreen" },
): string[] {
  const problems: string[] = [];
  const ids = assets.map((a) => a.id);
  if (job.mode === "auto" && job.frames?.length && !draft.speaker_side)
    problems.push(
      'speaker_side is missing: say where the speaker sits in the frames ("left", "center", "right" or "none").',
    );
  draft.scenes.forEach((s, i) => {
    if (job.mode === "auto" && !s.mode)
      problems.push(`scenes[${i}].mode is missing: choose "fullscreen" or "overlay".`);
    for (const use of s.assets ?? []) {
      const asset = assets.find((a) => a.id === use.id);
      if (!asset) {
        problems.push(
          `scenes[${i}].assets "${use.id}" is not one of the editor's images (${ids.join(", ") || "none"}).`,
        );
        continue;
      }
      for (const [j, mark] of (use.marks ?? []).entries()) {
        const r = resolveMark(mark, asset);
        if (typeof r === "string")
          problems.push(`scenes[${i}].assets ${use.id} marks[${j}]: ${r}.`);
        if (mark.at_s < s.start_s || mark.at_s >= s.end_s)
          problems.push(`scenes[${i}].assets ${use.id} marks[${j}].at_s is outside its scene.`);
      }
    }
    if (style.unsupported.includes(s.technique)) {
      problems.push(
        `scenes[${i}].technique "${s.technique}" is not supported by the style ${style.name}.`,
      );
    }
    for (const c of s.sfx) {
      if (!style.sounds.includes(c.sound)) {
        problems.push(
          `scenes[${i}].sfx sound "${c.sound}" is not in the palette (${style.sounds.join(", ")}).`,
        );
      }
    }
  });
  return problems;
}

/** The frames of the footage, which come first among the attached images. */
function frameLines(frames: RangeFrame[]): string[] {
  if (!frames.length) return [];
  return [
    `The first ${frames.length} attached image(s) are frames of the footage under this range, at ${frames.map((f) => `${f.atS.toFixed(1)} s`).join(", ")}.`,
    "",
  ];
}

/** How the scene modes are decided, by the job's mode. */
function modeLines(job: PlanJob): string[] {
  if (job.mode !== "auto")
    return [
      `Output: ${job.mode} for every scene, ${job.format} ${job.width}x${job.height}`,
      job.mode === "overlay" && job.frames?.length
        ? 'Say where the speaker sits in the frames with "speaker_side".'
        : "",
    ].filter(Boolean);
  return [
    `Output: automatic, ${job.format} ${job.width}x${job.height}. Choose "mode" for every scene (fullscreen or overlay) as the section "Fullscreen or overlay" says.`,
    job.frames?.length
      ? 'Say where the speaker sits in the frames with "speaker_side".'
      : "No frames of the footage were given: assume the speaker is in the centre of the frame.",
  ];
}

/** The editor's images, described next to their previews (which come right after any frames). */
function assetLines(assets: PreparedAsset[], afterFrames: boolean): string[] {
  if (!assets.length) return [];
  return [
    `The editor added ${assets.length} image(s); their previews are attached ${afterFrames ? "after the frames" : "above"}, in this order:`,
    ...assets.flatMap((a) => [
      `- ${a.id}: ${a.width}x${a.height}${a.has_alpha ? ", transparent background" : ""}${a.note ? `, editor's note: "${a.note}"` : ""}`,
      ...(a.lines?.length
        ? [
            `  Text read in ${a.id} (line id, x y width height in its pixels, text):`,
            ...a.lines
              .slice(0, 80)
              .map((l) => `  ${l.id} [${l.box.join(" ")}] ${JSON.stringify(l.text.slice(0, 120))}`),
          ]
        : []),
    ]),
    "",
  ];
}

export function planRequestText(transcript: Transcript, style: StyleInfo, job: PlanJob): string {
  const words = transcript.words
    .map((w) => `${w.start.toFixed(2)}-${w.end.toFixed(2)} ${w.text}`)
    .join("\n");
  const supported = TECHNIQUES.filter((t) => !style.unsupported.includes(t));
  return [
    `Range duration: ${transcript.duration_s.toFixed(2)} s (${formatFps(job.fps)} fps)`,
    ...modeLines(job),
    `Language of the speech: ${transcript.language ?? "detect from the transcript"}`,
    job.note ? `Editor's note: ${job.note}` : null,
    ...partLines(job.part),
    "",
    `Style: ${style.name}`,
    `Techniques this style supports: ${supported.join(", ")}`,
    `Sound palette (use only these names): ${style.sounds.join(", ")}`,
    "",
    "Style description:",
    style.styleMd,
    "",
    ...frameLines(job.frames ?? []),
    ...assetLines(job.assets ?? [], Boolean(job.frames?.length)),
    "Transcript (start-end seconds, word):",
    words,
  ]
    .filter((l) => l !== null)
    .join("\n");
}

export interface PlanOptions {
  provider: TextProvider;
  transcript: Transcript;
  style: StyleInfo;
  job: PlanJob;
  maxAttempts?: number;
  onProgress?: (message: string) => void;
}

/** Asks the model for a plan, validates it, and feeds problems back until it passes (at most 3 tries). */
export async function planInsert(o: PlanOptions): Promise<Plan> {
  const maxAttempts = o.maxAttempts ?? 3;
  const messages: ChatMessage[] = [
    {
      role: "user",
      content: [
        ...(o.job.frames ?? []).map((f) => ({
          type: "image" as const,
          mediaType: f.preview.mediaType,
          base64: f.preview.base64,
        })),
        ...(o.job.assets ?? []).map((a) => ({
          type: "image" as const,
          mediaType: a.preview.mediaType,
          base64: a.preview.base64,
        })),
        { type: "text", text: planRequestText(o.transcript, o.style, o.job) },
      ],
    },
  ];
  let lastProblems: string[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    o.onProgress?.(attempt === 1 ? "Planning scenes" : `Planning scenes (repair ${attempt - 1})`);
    const reply = await o.provider.complete({
      system: loadPrompt("plan"),
      messages,
      maxTokens: 16_000,
      purpose: "plan",
    });
    messages.push({ role: "assistant", content: [{ type: "text", text: reply.text }] });
    let problems: string[];
    try {
      const draft = PlanDraftSchema.parse(extractJson(reply.text));
      problems = planProblems(draft, o.style, o.job.assets ?? [], o.job);
      if (problems.length === 0) return draftToPlan(draft, o.job, o.transcript.duration_s);
    } catch (err) {
      problems =
        err instanceof z.ZodError
          ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`)
          : [String(err instanceof Error ? err.message : err)];
    }
    lastProblems = problems;
    messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text: `The plan is not valid yet. Fix these problems and reply with the full JSON again:\n- ${problems.join("\n- ")}`,
        },
      ],
    });
  }
  throw new Error(
    `The model could not produce a valid plan in ${maxAttempts} attempts:\n- ${lastProblems.join("\n- ")}`,
  );
}

/** Words of one scene with times relative to the scene start. */
export function sceneWords(
  transcript: Transcript,
  plan: Plan,
  sceneId: string,
): { text: string; at: number }[] {
  const fps = parseFps(plan.fps);
  const scene = plan.scenes.find((s) => s.id === sceneId);
  if (!scene) return [];
  const t0 = framesToSeconds(scene.start_frame, fps);
  const t1 = framesToSeconds(scene.end_frame, fps);
  return transcript.words
    .filter((w) => w.start >= t0 - 0.05 && w.start < t1)
    .map((w) => ({ text: w.text, at: Math.max(0, w.start - t0) }));
}
