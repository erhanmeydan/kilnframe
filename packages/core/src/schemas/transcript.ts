import { z } from "zod";

export const WordSchema = z
  .object({
    text: z.string().min(1),
    /** Seconds from the start of the audio. */
    start: z.number().nonnegative(),
    end: z.number().nonnegative(),
  })
  .refine((w) => w.end >= w.start, { message: "word end must not be before its start" });

export const TranscriptSchema = z
  .object({
    version: z.literal(1),
    /** Language code reported by or forced on the model, e.g. "tr". */
    language: z.string().nullable(),
    model: z.string().min(1),
    duration_s: z.number().positive(),
    text: z.string(),
    words: z.array(WordSchema),
  })
  .superRefine((t, ctx) => {
    t.words.forEach((w, i) => {
      const prev = t.words[i - 1];
      if (prev && w.start < prev.start) {
        ctx.addIssue({
          code: "custom",
          path: ["words", i],
          message: "words must be in time order",
        });
      }
      if (w.end > t.duration_s + 0.05) {
        ctx.addIssue({ code: "custom", path: ["words", i], message: "word ends after the audio" });
      }
    });
  });

export type Word = z.infer<typeof WordSchema>;
export type Transcript = z.infer<typeof TranscriptSchema>;
