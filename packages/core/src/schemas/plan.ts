import { z } from "zod";
import { parseFps } from "../fps.js";

/** Visual techniques. v2 entries are accepted by the schema but not yet planned. */
export const TECHNIQUES = [
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
] as const;
export const TechniqueSchema = z.enum(TECHNIQUES);

export const OUTPUT_MODES = ["fullscreen", "overlay"] as const;
export const OutputModeSchema = z.enum(OUTPUT_MODES);

/** Where the speaker sits in the frames of the range, read by the plan step from a few frames. */
export const SPEAKER_SIDES = ["left", "center", "right", "none"] as const;
export const SpeakerSideSchema = z.enum(SPEAKER_SIDES);

export const OUTPUT_FORMATS = ["landscape", "portrait", "square"] as const;
export const OutputFormatSchema = z.enum(OUTPUT_FORMATS);

const FpsStringSchema = z.string().refine(
  (s) => {
    try {
      parseFps(s);
      return true;
    } catch {
      return false;
    }
  },
  { message: 'fps must look like "25" or "30000/1001"' },
);

export const ImageRequestSchema = z.object({
  id: z.string().min(1),
  purpose: z.enum(["texture", "illustration", "character", "background"]),
  prompt: z.string().min(1),
  size: z.enum(["1024x1024", "1536x1024", "1024x1536"]),
  transparent: z.boolean(),
});

export const SfxCueSchema = z.object({
  /** Frame on the insert timeline, counted from the first body frame (handles excluded). */
  frame: z.number().int().nonnegative(),
  /** A sound name from the style's sfx palette (styles/<style>/sfx.json). */
  type: z.string().min(1),
  gain_db: z.number().max(0),
});

/** An image the editor added (packages/core/src/assets.ts), as the plan records it. */
export const AssetInfoSchema = z.object({
  id: z.string().regex(/^a\d+$/),
  /** Path inside the HyperFrames project, the src a scene uses. */
  src: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  has_alpha: z.boolean(),
  note: z.string().nullable(),
});
export type AssetInfo = z.infer<typeof AssetInfoSchema>;

export const ASSET_ROLES = ["hero", "background", "texture", "logo", "screenshot"] as const;

export const MARK_KINDS = ["underline", "circle", "box", "highlight", "arrow", "strike"] as const;

/** A mark drawn over a screenshot at a moment of the speech; box is in the image's own pixels. */
export const MarkSchema = z.object({
  kind: z.enum(MARK_KINDS),
  box: z.tuple([z.number(), z.number(), z.number().positive(), z.number().positive()]),
  /** Frame on the insert timeline (handles excluded), like sound cues. */
  frame: z.number().int().nonnegative(),
  /** The read text the mark covers, when it marks text. */
  text: z.string().nullable(),
});
export type Mark = z.infer<typeof MarkSchema>;

/** A user image placed in a scene; older plans list bare ids, read as the main subject. */
export const AssetUseSchema = z.preprocess(
  (v) => (typeof v === "string" ? { id: v, role: "hero" } : v),
  z.object({
    id: z.string().min(1),
    role: z.enum(ASSET_ROLES),
    marks: z.array(MarkSchema).default([]),
  }),
);
export type AssetUse = z.infer<typeof AssetUseSchema>;

export const SceneSchema = z
  .object({
    id: z.string().regex(/^s\d+$/, 'scene ids look like "s1", "s2"'),
    start_frame: z.number().int().nonnegative(),
    end_frame: z.number().int().positive(),
    anchor_words: z.array(z.string().min(1)),
    visual: z.string().min(1),
    on_screen_text: z.string().nullable(),
    camera: z.string().min(1),
    technique: TechniqueSchema,
    assets: z.array(AssetUseSchema),
    transition_out: z.string().min(1),
    image_requests: z.array(ImageRequestSchema),
    sfx: z.array(SfxCueSchema),
    /**
     * Fullscreen covers the footage, overlay sits over it on a transparent background. Chosen per scene in
     * automatic mode; older plans leave it out and every scene follows the plan's mode (sceneMode()).
     */
    mode: OutputModeSchema.optional(),
    /** A scene recipe (recipes/<name>/) the scene is filled from instead of being written; free when absent. */
    recipe: z.string().min(1).nullable().optional(),
  })
  .refine((s) => s.end_frame > s.start_frame, {
    message: "end_frame must be after start_frame",
    path: ["end_frame"],
  });

export const PlanSchema = z
  .object({
    version: z.literal(1),
    topic: z.string().min(1),
    summary: z.string().min(1),
    style: z.string().min(1),
    /** overlay as soon as one scene is: the whole insert then renders with alpha (ProRes 4444). */
    mode: OutputModeSchema,
    /** Where the speaker is in the footage, when the plan step saw frames of the range. */
    speaker: z.object({ side: SpeakerSideSchema }).nullable().optional(),
    format: OutputFormatSchema,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: FpsStringSchema,
    duration_frames: z.number().int().positive(),
    handles_frames: z.number().int().nonnegative(),
    /** The editor's images for this insert; scenes refer to them by id. */
    assets: z.array(AssetInfoSchema).default([]),
    scenes: z.array(SceneSchema).min(1),
  })
  .superRefine((p, ctx) => {
    const ids = new Set<string>();
    p.scenes.forEach((s, i) => {
      if (ids.has(s.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["scenes", i, "id"],
          message: `duplicate scene id ${s.id}`,
        });
      }
      ids.add(s.id);
      if (s.end_frame > p.duration_frames) {
        ctx.addIssue({
          code: "custom",
          path: ["scenes", i, "end_frame"],
          message: `scene ends at frame ${s.end_frame}, after the insert (${p.duration_frames} frames)`,
        });
      }
      const prev = p.scenes[i - 1];
      if (prev && s.start_frame < prev.end_frame) {
        ctx.addIssue({
          code: "custom",
          path: ["scenes", i, "start_frame"],
          message: `scene ${s.id} overlaps ${prev.id}`,
        });
      }
      s.assets.forEach((use, j) => {
        if (!p.assets.some((a) => a.id === use.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["scenes", i, "assets", j, "id"],
            message: `scene uses image ${use.id}, which is not among the editor's images`,
          });
        }
      });
      s.sfx.forEach((cue, j) => {
        if (cue.frame >= p.duration_frames) {
          ctx.addIssue({
            code: "custom",
            path: ["scenes", i, "sfx", j, "frame"],
            message: "sound cue is after the end of the insert",
          });
        }
      });
    });
    const first = p.scenes[0];
    const last = p.scenes[p.scenes.length - 1];
    if (first && first.start_frame !== 0) {
      ctx.addIssue({
        code: "custom",
        path: ["scenes", 0, "start_frame"],
        message: "first scene must start at frame 0",
      });
    }
    if (last && last.end_frame !== p.duration_frames) {
      ctx.addIssue({
        code: "custom",
        path: ["scenes", p.scenes.length - 1, "end_frame"],
        message: "last scene must end at duration_frames",
      });
    }
  });

export type Technique = z.infer<typeof TechniqueSchema>;
export type SpeakerSide = z.infer<typeof SpeakerSideSchema>;
export type OutputMode = z.infer<typeof OutputModeSchema>;
export type OutputFormat = z.infer<typeof OutputFormatSchema>;
export type Scene = z.infer<typeof SceneSchema>;
export type Plan = z.infer<typeof PlanSchema>;

/** A scene's own mode, or the plan's for plans made before modes were chosen per scene. */
export function sceneMode(plan: Pick<Plan, "mode">, scene: Pick<Scene, "mode">): OutputMode {
  return scene.mode ?? plan.mode;
}
