// packages/core/src/music/score/write-plan.ts
// The music plan from the user's text model: transcript with word times in, a sectioned plan out, checked and
// repaired like the scene plan.
import { framePreview } from "../../frames.js";
import { loadPrompt, extractJson } from "../../prompts.js";
import type { ChatMessage, TextProvider } from "../../providers/types.js";
import type { Transcript } from "../../schemas/transcript.js";
import {
  MusicPlanSchema,
  musicPlanProblems,
  snapPlan,
  splitLong,
  type MusicPlan,
  type MusicSection,
} from "./plan.js";

const RULES =
  "Instrumental only, no vocals, no singing, no spoken words. Background score under speech: keep the mid range (300 Hz to 3 kHz) open for the voice, no busy lead melody.";

export function lyriaPrompt(plan: MusicPlan, s: MusicSection): string {
  const len = Math.round(s.endS - s.startS);
  const close = s.final
    ? "It ends the video: let it grow towards the end and close in the way that suits the music best."
    : s.transitionOut === "end"
      ? "It ends with a clear, resolved close."
      : "It keeps going steadily to the end, no ending.";
  return [
    `${plan.world}.`,
    s.prompt,
    `About ${len} seconds, around ${Math.round(s.tempo)} BPM.`,
    close,
    RULES,
  ].join(" ");
}

function speechText(t: Transcript | null): string {
  if (!t || !t.words.length) return "There is no speech in this range: music only.";
  return t.words.map((w) => `[${w.start.toFixed(1)}-${w.end.toFixed(1)}] ${w.text}`).join(" ");
}

export async function writeMusicPlan(o: {
  provider: TextProvider;
  transcript: Transcript | null;
  durationS: number;
  note?: string | undefined;
  language: string;
  frames?: { path: string; atS: number }[] | undefined;
  maxAttempts?: number;
  onProgress?: ((m: string) => void) | undefined;
}): Promise<MusicPlan> {
  o.onProgress?.("Planning the music");
  const images: ChatMessage["content"] = (o.frames ?? []).map((f) => ({
    type: "image" as const,
    ...framePreview(f.path),
  }));
  const messages: ChatMessage[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: [
            `Range length: ${o.durationS.toFixed(2)} s. Panel language: ${o.language}.`,
            o.note?.trim()
              ? `The editor's wishes: ${o.note.trim()}`
              : "No wishes from the editor: choose.",
            `Speech with word times (seconds):\n${speechText(o.transcript)}`,
          ].join("\n"),
        },
        ...images,
      ],
    },
  ];
  const words = o.transcript?.words ?? [];
  const tries = o.maxAttempts ?? 3;
  let last: unknown;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const reply = await o.provider.complete({
      system: loadPrompt("music-plan"),
      messages,
      maxTokens: 6000,
      purpose: "music-plan",
    });
    try {
      const plan = splitLong(
        snapPlan(MusicPlanSchema.parse(extractJson(reply.text)), words, o.durationS),
      );
      const problems = musicPlanProblems(plan, o.durationS);
      if (!problems.length) return plan;
      last = new Error(problems.join("\n"));
    } catch (err) {
      last = err;
    }
    messages.push({ role: "assistant", content: [{ type: "text", text: reply.text }] });
    messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text: `Not right yet. Fix these and reply with the full JSON again:\n- ${String(
            last instanceof Error ? last.message : last,
          )
            .split("\n")
            .join("\n- ")}`,
        },
      ],
    });
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export async function rewriteSectionPrompt(o: {
  provider: TextProvider;
  plan: MusicPlan;
  sectionId: string;
  note: string;
}): Promise<string> {
  const s = o.plan.sections.find((x) => x.id === o.sectionId);
  if (!s) throw new Error(`No section ${o.sectionId}`);
  const reply = await o.provider.complete({
    system:
      'You rewrite one instruction for a music model. Reply with JSON only: {"prompt":"..."} in English. Never ask for vocals or words.',
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Sound of the whole video: ${o.plan.world}\nSection "${s.title}" now: ${s.prompt}\nThe editor wants: ${o.note}`,
          },
        ],
      },
    ],
    maxTokens: 600,
    purpose: "music-rewrite",
  });
  const parsed = extractJson(reply.text) as { prompt?: unknown };
  if (typeof parsed?.prompt !== "string" || !parsed.prompt.trim())
    throw new Error("No prompt in the answer.");
  return parsed.prompt.trim();
}
