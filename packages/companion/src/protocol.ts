import { z } from "zod";

export const PROTOCOL_VERSION = 1;

/** Parameters of one insert job, as the panel sends them. */
export const RenderJobParamsSchema = z.object({
  kind: z.literal("render").optional(),
  audioPath: z.string().min(1),
  /** In/out of the range in seconds, when audioPath is the whole sequence's audio. */
  rangeStartS: z.number().nonnegative().optional(),
  rangeEndS: z.number().positive().optional(),
  outDir: z.string().min(1),
  style: z.string().min(1),
  /** auto: the plan step picks fullscreen or overlay per scene, looking at frames when given. */
  mode: z.enum(["fullscreen", "overlay", "auto"]),
  format: z.enum(["landscape", "portrait", "square"]).optional(),
  fps: z.string().min(1),
  sequenceSize: z.string().regex(/^\d+x\d+$/),
  language: z.string().optional(),
  note: z.string().optional(),
  stillsOnly: z.boolean().optional(),
  /** Story mode: the text that was read aloud, so names are spelled as written (core align.ts). */
  scriptPath: z.string().min(1).optional(),
  /** A part of a long range: its transcript from the parts job (skips Whisper) and its place in the whole. */
  transcriptPath: z.string().min(1).optional(),
  part: z
    .object({
      index: z.number().int().positive(),
      count: z.number().int().positive(),
      before: z.string().max(400).optional(),
      after: z.string().max(400).optional(),
    })
    .optional(),
  /** Frames of the footage under the range (exported by the panel), seconds from the range start. */
  frames: z
    .array(z.object({ path: z.string().min(1), atS: z.number().nonnegative() }))
    .max(6)
    .optional(),
  /** The editor's own images (logo, product shots, screenshots), up to 12, with an optional note each. */
  assets: z
    .array(z.object({ path: z.string().min(1), note: z.string().max(200).optional() }))
    .max(12)
    .optional(),
  /**
   * run (default): the whole pipeline. render: the editor approved the stills; render the job folder in
   * outDir without model calls. recompose: write sceneId again with note, then fresh stills.
   */
  action: z.enum(["run", "render", "recompose"]).optional(),
  sceneId: z
    .string()
    .regex(/^s\d+$/)
    .optional(),
  /** auto, claude-code, an id from providers.json, or custom (an OpenAI compatible address). */
  provider: z.string().min(1).optional(),
  model: z.string().optional(),
  baseURL: z.string().url().optional(),
});
export type RenderJobParams = z.infer<typeof RenderJobParamsSchema>;

/**
 * Your Own Style: make a style from a description and up
 * to 4 references, or revise one of the editor's styles with a note; both end with a three-scene preview.
 */
export const StyleJobParamsSchema = z.object({
  kind: z.literal("style"),
  description: z.string().max(2000).default(""),
  references: z
    .array(z.object({ path: z.string().min(1), note: z.string().max(200).optional() }))
    .max(4)
    .default([]),
  /** A style of the editor's to change with `note`. */
  revise: z.string().optional(),
  note: z.string().max(1000).optional(),
  /** auto, claude-code, an id from providers.json, or custom (an OpenAI compatible address). */
  provider: z.string().min(1).optional(),
  model: z.string().optional(),
  baseURL: z.string().url().optional(),
});
export type StyleJobParams = z.infer<typeof StyleJobParamsSchema>;

const ProviderChoice = {
  /** auto, claude-code, an id from providers.json, or custom (an OpenAI compatible address). */
  provider: z.string().min(1).optional(),
  model: z.string().optional(),
  baseURL: z.string().url().optional(),
};

/** Story mode, step one: write the narration from a brief, or revise it with a note. */
export const StoryWriteJobParamsSchema = z.object({
  kind: z.literal("story-write"),
  brief: z.string().max(4000).default(""),
  durationS: z.number().min(10).max(600),
  language: z.string().min(2).max(10),
  tone: z.string().max(300).optional(),
  revise: z
    .object({
      story: z.object({
        title: z.string(),
        voice_style: z.string(),
        paragraphs: z.array(z.string()),
      }),
      note: z.string().max(1000),
    })
    .optional(),
  ...ProviderChoice,
});

/** Story mode, step two: read the approved narration aloud into the job folder. */
export const StoryVoiceJobParamsSchema = z.object({
  kind: z.literal("story-voice"),
  title: z.string().max(200).default("Story"),
  text: z.string().min(1).max(20000),
  voice: z.string().min(1),
  style: z.string().max(300).optional(),
  outDir: z.string().min(1),
  speechModel: z.string().optional(),
  /** A Lyria music bed under the narration, in the chosen style's mood when there is one. */
  music: z
    .object({
      style: z.string().optional(),
      subject: z.string().max(400).optional(),
    })
    .optional(),
});

/** A long range: transcribe it once and split it into parts at sentence ends (core parts.ts). */
export const PartsJobParamsSchema = z.object({
  kind: z.literal("parts"),
  audioPath: z.string().min(1),
  rangeStartS: z.number().nonnegative().optional(),
  rangeEndS: z.number().positive().optional(),
  outDir: z.string().min(1),
  language: z.string().optional(),
  targetS: z.number().min(10).max(120).optional(),
  scriptPath: z.string().min(1).optional(),
});
export type PartsJobParams = z.infer<typeof PartsJobParamsSchema>;

export const JobParamsSchema = z.union([
  PartsJobParamsSchema,
  StyleJobParamsSchema,
  StoryWriteJobParamsSchema,
  StoryVoiceJobParamsSchema,
  RenderJobParamsSchema,
]);
export type StoryWriteJobParams = z.infer<typeof StoryWriteJobParamsSchema>;
export type StoryVoiceJobParams = z.infer<typeof StoryVoiceJobParamsSchema>;
export type JobParams = z.infer<typeof JobParamsSchema>;

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    token: z.string().min(1),
    client: z.string().optional(),
    /** The panel's PROTOCOL_VERSION, so the companion can tell which side is out of date. */
    protocol: z.number().int().optional(),
  }),
  z.object({ type: z.literal("status") }),
  z.object({ type: z.literal("system.check") }),
  z.object({ type: z.literal("models.prepare") }),
  z.object({
    type: z.literal("models.list"),
    provider: z.string().min(1),
    baseURL: z.string().url().optional(),
  }),
  /** `ref` is echoed in job.accepted so the panel can match the job id to its request. */
  z.object({ type: z.literal("job.start"), params: JobParamsSchema, ref: z.string().optional() }),
  z.object({ type: z.literal("styles.list") }),
  z.object({
    type: z.literal("job.prepare"),
    projectPath: z.string().optional(),
    sequenceName: z.string().min(1),
  }),
  z.object({ type: z.literal("job.cancel"), jobId: z.string() }),
  z.object({ type: z.literal("job.get"), jobId: z.string() }),
  z.object({ type: z.literal("styles.delete"), name: z.string().min(1) }),
  z.object({ type: z.literal("speech.voices") }),
  z.object({
    type: z.literal("speech.preview"),
    // part of a cache file name, so a plain voice name only
    voice: z.string().regex(/^[A-Za-z0-9_.-]{1,60}$/),
    language: z.string().regex(/^[A-Za-z-]{2,10}$/),
  }),
  z.object({ type: z.literal("speech.stop") }),
  z.object({ type: z.literal("assets.inspect"), paths: z.array(z.string().min(1)).max(12) }),
  z.object({ type: z.literal("providers.list") }),
  /** Opens the official sign-in of an agent CLI in a terminal window the editor sees. */
  z.object({ type: z.literal("agent.login"), agent: z.enum(["claude-code", "codex", "grok"]) }),
  /** Opens an agent CLI's own update in a terminal window. */
  z.object({ type: z.literal("agent.update"), agent: z.enum(["claude-code", "codex", "grok"]) }),
  z.object({ type: z.literal("review.load"), outDir: z.string().min(1) }),
  z.object({
    type: z.literal("providers.test"),
    provider: z.string().min(1),
    model: z.string().optional(),
    baseURL: z.string().url().optional(),
  }),
  /** Downloads and installs the app update the companion announced (refused while a job runs). */
  z.object({ type: z.literal("app.update.install") }),
  z.object({ type: z.literal("keys.set"), provider: z.string().min(1), key: z.string().min(1) }),
  z.object({ type: z.literal("keys.has"), provider: z.string().min(1) }),
  z.object({ type: z.literal("keys.delete"), provider: z.string().min(1) }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";

export interface JobSummary {
  id: string;
  state: JobState;
  position: number | null;
  style: string;
  createdAt: string;
}

/**
 * The app's own update (Kilnframe Helper, electron-updater), relayed by the companion: the app checks GitHub
 * Releases, the panel shows it and asks; nothing installs without the editor.
 */
export interface AppUpdateState {
  status: "checking" | "none" | "available" | "downloading" | "ready" | "error";
  /** The app that runs now. */
  current: string;
  /** The new version, when there is one. */
  version?: string | undefined;
  notes?: string | undefined;
  percent?: number | undefined;
  error?: string | undefined;
}

export type ServerMessage =
  | { type: "ready"; protocol: number; version: string }
  | { type: "app.update"; update: AppUpdateState }
  /** A job is queued or running; the update waits until it is done. */
  | { type: "app.update.busy" }
  | { type: "status"; jobs: JobSummary[] }
  | { type: "system"; report: unknown }
  | { type: "models.progress"; message: string }
  | { type: "models.ready" }
  | { type: "models.failed"; message: string }
  | { type: "models"; provider: string; models: unknown[] }
  | { type: "job.queued"; jobId: string; position: number }
  | { type: "job.accepted"; jobId: string; ref?: string }
  | { type: "styles"; styles: unknown[] }
  | { type: "job.prepared"; jobDir: string }
  | { type: "job.progress"; jobId: string; message: string }
  | { type: "job.done"; jobId: string; result: unknown }
  | { type: "job.error"; jobId: string; message: string; kind?: string | undefined }
  | { type: "job.cancelled"; jobId: string }
  | { type: "job.state"; jobId: string; state: JobState | "unknown" }
  | { type: "assets"; assets: unknown[] }
  | { type: "styles.deleted"; name: string }
  | { type: "voices"; provider: string; model: string; voices: unknown[]; keySet: boolean }
  | { type: "speech.played"; voice: string }
  /** The sample stopped: it finished, Stop was pressed, or another one started. */
  | { type: "speech.ended"; voice: string }
  | {
      type: "providers";
      providers: unknown[];
      claudeCode: unknown;
      codex: unknown;
      grok: unknown;
      updates: unknown;
    }
  | { type: "agent.login.opened"; agent: string }
  | { type: "agent.update.opened"; agent: string }
  | { type: "review"; outDir: string; review: unknown }
  | { type: "providers.tested"; provider: string; result: unknown }
  | { type: "keys.has"; provider: string; present: boolean }
  | { type: "keys.saved"; provider: string }
  | { type: "keys.deleted"; provider: string }
  | { type: "error"; message: string };
