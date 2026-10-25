import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { framesToSeconds, parseFps } from "../fps.js";
import { extractHtml, loadPrompt, techniqueModule } from "../prompts.js";
import type { ChatMessage, ContentPart, TextProvider } from "../providers/types.js";
import { safeArea } from "../safe-area.js";
import { nearestFrame, type RangeFrame } from "../frames.js";
import { sceneMode, type Plan, type Scene } from "../schemas/plan.js";
import type { Transcript } from "../schemas/transcript.js";
import type { StyleInfo } from "../styles.js";
import { sceneWords } from "./plan.js";

/** Cheap checks before HyperFrames: things that would break determinism or the scene contract. */
/** The project paths of the editor's images a scene was planned to use. */
export function sceneAssetSrcs(plan: Plan, scene: Scene): string[] {
  return scene.assets
    .map((use) => plan.assets.find((a) => a.id === use.id)?.src)
    .filter((src): src is string => !!src);
}

export function staticSceneProblems(
  html: string,
  sceneId: string,
  assetSrcs: string[] = [],
  overlay = false,
): string[] {
  const p: string[] = [];
  // a grain or noise layer in an overlay scene lays a faint haze over the speaker (9 Oct 2026: a
  // whiteboard overlay put 6% paper grain over the whole frame, about 2% alpha across the face)
  if (overlay && /feTurbulence|grain/i.test(html))
    p.push(
      "This is an overlay scene: it must not use grain, noise or paper texture (feTurbulence, a grain layer). Over the footage it shows as a faint haze across the speaker. Keep the overlay graphics flat; leave texture to fullscreen scenes.",
    );
  const rules: [RegExp, string][] = [
    [
      /https?:\/\/(?!www\.w3\.org)/i,
      "loads something from the network (http/https URL); everything must be local",
    ],
    [/Math\.random\s*\(/, "uses Math.random(); use a seeded generator"],
    [
      /Date\.now\s*\(|performance\.now\s*\(|new Date\s*\(/,
      "reads the clock; frames must depend only on time from the timeline",
    ],
    [
      /requestAnimationFrame|setAnimationLoop|setInterval\s*\(|setTimeout\s*\(/,
      "runs its own loop or timer; drive everything from the timeline",
    ],
    [/repeat\s*:\s*-1/, "uses repeat: -1; use a finite repeat count"],
    [/\.play\s*\(\s*\)/, "calls play(); the renderer seeks the paused timeline itself"],
    [/PCFSoftShadowMap/, "uses PCFSoftShadowMap, which no longer exists; use THREE.PCFShadowMap"],
    [
      /visibility\s*[:=]\s*["'`]visible["'`]|autoAlpha/,
      "shows elements with visibility or autoAlpha; a child set to visible stays on screen after the scene ends, so use opacity",
    ],
  ];
  for (const [re, msg] of rules) if (re.test(html)) p.push(`The scene ${msg}.`);
  if (!new RegExp(`data-composition-id=["']${sceneId}["']`).test(html))
    p.push(`The root must have data-composition-id="${sceneId}".`);
  if (!registersTimeline(html, sceneId))
    p.push(`The scene must register window.__timelines["${sceneId}"].`);
  for (const src of assetSrcs)
    if (!html.includes(src))
      p.push(
        `The plan gives this scene the editor's image "${src}", but the scene never loads it. Use it with exactly that src.`,
      );
  if (!/<template[\s>][\s\S]*<\/template>/i.test(html))
    p.push("Everything must be inside <template>.");
  const rootTag = /<[a-z]+\b[^>]*data-composition-id=["'][^"']+["'][^>]*>/i.exec(html)?.[0];
  const rootId = rootTag?.match(/\sid=["']([^"']+)["']/)?.[1];
  if (rootId && scriptsOf(html).some((js) => lookupOf(js, rootId)))
    p.push(
      `The script looks up the root by its id "${rootId}", but the root loses its id when the scene is mounted. Look up child elements by their own ids, or the root with document.querySelector('[data-composition-id="${sceneId}"]').`,
    );
  const rootClass = rootTag?.match(/\sclass=["']([^"']+)["']/)?.[1];
  if (rootClass)
    p.push(
      `The root element has class="${rootClass}"; a class on the root breaks its styling at render. Remove it and style the root only through #root.`,
    );
  const ids = [...html.matchAll(/\sid=["']([^"']+)["']/g)].map((m) => m[1] as string);
  const foreign = ids.filter((id) => id !== "root" && !id.startsWith(`${sceneId}-`));
  if (foreign.length)
    p.push(
      `Every id except root must start with "${sceneId}-"; these do not: ${[...new Set(foreign)].join(", ")}.`,
    );
  return p;
}

/**
 * The scene registers its timeline under its id: `__timelines["s2"] =`, `__timelines.s2 =`, or through a
 * variable that holds the id (`const SCENE_ID = "s2"; window.__timelines[SCENE_ID] = tl`). The last form
 * was rejected before, so MiniMax M3 and a local Qwen failed three times on correct scenes (9 Oct 2026).
 */
export function registersTimeline(html: string, sceneId: string): boolean {
  const id = sceneId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`__timelines\\[\\s*["'\`]${id}["'\`]\\s*\\]\\s*=(?!=)`).test(html)) return true;
  if (new RegExp(`__timelines\\.${id}\\s*=(?!=)`).test(html)) return true;
  for (const m of html.matchAll(/__timelines\[\s*([A-Za-z_$][\w$]*)\s*\]\s*=(?!=)/g)) {
    const name = (m[1] as string).replace(/\$/g, "\\$");
    if (new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*["'\`]${id}["'\`]`).test(html))
      return true;
  }
  return false;
}

function scriptsOf(html: string): string[] {
  return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1] ?? "");
}

/** True when the script finds an element by this id (getElementById or a #id selector). */
function lookupOf(js: string, id: string): boolean {
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`getElementById\\(\\s*["'\`]${esc}["'\`]|["'\`][^"'\`]*#${esc}(?![\\w-])`).test(
    js,
  );
}

export interface ComposeContext {
  provider: TextProvider;
  plan: Plan;
  transcript: Transcript;
  style: StyleInfo;
  /** Previews of the editor's images by id, so the model sees what it places. */
  assetPreviews?: Record<string, { mediaType: "image/png" | "image/jpeg"; base64: string }>;
  /** Frames of the footage; an overlay scene sees the one nearest to it, to sit beside the speaker. */
  frames?: RangeFrame[];
  /** Where a reply the checks turned down is kept with its problems, so a failure can be read later. */
  rejectedDir?: string;
}

/** Keeps a turned-down reply next to the job (<job>/rejected/<scene>-<n>.txt). */
export function keepRejected(
  dir: string | undefined,
  name: string,
  reply: string,
  problems: string[],
) {
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.txt`), `Problems:\n- ${problems.join("\n- ")}\n\n${reply}\n`);
  } catch {
    // only a help for reading failures later
  }
}

/** Where an overlay scene may draw, from where the speaker sits (plan.speaker) and the frame's shape. */
export function overlayPlacement(plan: Plan): string {
  const side = plan.speaker?.side ?? "center";
  if (side === "none")
    return "Nobody is on screen in the footage: the graphics may use the whole frame, but the background stays transparent.";
  if (plan.format === "portrait")
    return "The speaker fills the middle of the vertical frame: put the graphics in the band above the head or in the lower third, never over the face.";
  if (side === "left" || side === "right") {
    const free = side === "left" ? "right" : "left";
    return `The speaker is on the ${side} of the frame: put the graphics in the ${free} half (from about 52% of the width to the ${free} safe edge) and leave the ${side} half clear.`;
  }
  return "The speaker is in the centre of the frame: keep the middle 40% of the width clear; use a narrow column at the left or right edge (at most 28% of the width) or the lower third below the chin.";
}

/** The mode lines of a scene's request: what the scene owns of the frame. */
function modeText(plan: Plan, scene: Scene, frameShown: boolean): string[] {
  const mode = sceneMode(plan, scene);
  if (mode === "fullscreen")
    return plan.mode === "overlay"
      ? [
          "Mode: fullscreen. This scene covers the footage: paint an opaque background over the whole canvas. Other scenes of this insert are overlays, so the insert renders with alpha and anything left transparent here would show the footage.",
        ]
      : ["Mode: fullscreen."];
  return [
    "Mode: overlay. The background is transparent (no full-frame fills, no backdrop); the graphics sit over the footage.",
    overlayPlacement(plan),
    frameShown
      ? "The last image above is a frame of the footage during this scene: place the graphics in its free space, clear of the face and the hands."
      : "",
    "Keep overlay graphics readable over any footage: give text a solid or softly shadowed plate in the style's colours rather than bare letters.",
  ].filter(Boolean);
}

function systemPrompt(scene: Scene): string {
  const module = techniqueModule(scene.technique);
  return [loadPrompt("compose"), module].filter(Boolean).join("\n\n");
}

export function composeRequest(ctx: ComposeContext, scene: Scene): ContentPart[] {
  const { plan, transcript, style } = ctx;
  const fps = parseFps(plan.fps);
  const duration = framesToSeconds(scene.end_frame - scene.start_frame, fps);
  const area = safeArea(plan.format, plan.width, plan.height);
  const words = sceneWords(transcript, plan, scene.id)
    .map((w) => `${w.at.toFixed(2)} ${w.text}`)
    .join("\n");
  const example = style.examples[scene.technique];
  const parts: ContentPart[] = [];
  if (ctx.provider.capabilities.vision) {
    for (const s of style.stills)
      parts.push({ type: "image", mediaType: s.mediaType, base64: s.base64 });
  }
  const used = scene.assets
    .map((use) => ({ use, info: plan.assets.find((a) => a.id === use.id) }))
    .filter((u) => u.info);
  const shown = used.filter((u) => ctx.assetPreviews?.[u.use.id]);
  for (const u of shown) {
    const preview = ctx.assetPreviews?.[u.use.id];
    if (preview)
      parts.push({ type: "image", mediaType: preview.mediaType, base64: preview.base64 });
  }
  const frame =
    sceneMode(plan, scene) === "overlay" && ctx.provider.capabilities.vision
      ? nearestFrame(
          ctx.frames ?? [],
          framesToSeconds((scene.start_frame + scene.end_frame) / 2, fps),
        )
      : null;
  if (frame)
    parts.push({ type: "image", mediaType: frame.preview.mediaType, base64: frame.preview.base64 });
  const assetText = used.length
    ? [
        "",
        `The editor's images for this scene${shown.length ? ` (their previews are the ${frame ? "images before the last one" : "last images above"}, in this order)` : ""}:`,
        ...used.flatMap(({ use, info }) => [
          `- ${use.id}, role ${use.role}: src "${info?.src}", ${info?.width}x${info?.height}${info?.has_alpha ? ", transparent background" : ""}${info?.note ? `, editor's note: "${info.note}"` : ""}`,
          ...use.marks.map(
            (m) =>
              `  mark: ${m.kind} at ${framesToSeconds(m.frame - scene.start_frame, fps).toFixed(2)} s, box [${m.box.join(", ")}] (x, y, width, height in the image's own ${info?.width}x${info?.height} pixels)${m.text ? `, over the text "${m.text}"` : ""}`,
          ),
        ]),
        'Load each with exactly that src and dress it as the style\'s "User images" section says.',
        ...(used.some((u) => u.use.marks.length)
          ? [
              "Draw each mark exactly over its box: scale the box by the size you display the image at (displayed x = image left + box x * displayed width / image width, the same for y) and draw it in an SVG layer on top of the image, in the style's drawing language, starting at its time.",
            ]
          : []),
      ]
    : [];
  const text = [
    ctx.provider.capabilities.vision && style.stills.length
      ? `The images above are the style's reference stills (${style.stills.map((s) => s.name).join(", ")}). Match their look.`
      : null,
    `SCENE_ID: ${scene.id}`,
    `Duration: ${duration.toFixed(3)} s`,
    `Canvas: ${plan.width}x${plan.height} (WIDTH=${plan.width}, HEIGHT=${plan.height}), format ${plan.format}`,
    `Safe area (px from each edge): top ${area.top}, right ${area.right}, bottom ${area.bottom}, left ${area.left}`,
    ...modeText(plan, scene, Boolean(frame)),
    "",
    "Scene plan:",
    JSON.stringify(
      {
        visual: scene.visual,
        on_screen_text: scene.on_screen_text,
        camera: scene.camera,
        technique: scene.technique,
        anchor_words: scene.anchor_words,
        sound_cues_s: scene.sfx.map((c) => ({
          at_s: +framesToSeconds(c.frame - scene.start_frame, fps).toFixed(3),
          sound: c.type,
        })),
      },
      null,
      2,
    ),
    "",
    ...assetText,
    "",
    "Words spoken in this scene (seconds from the scene start, word):",
    words || "(no words; music or silence)",
    "",
    `Insert topic: ${plan.topic}. ${plan.summary}`,
    "",
    `Style ${style.name}:`,
    style.styleMd,
    "",
    "Style tokens (tokens.json):",
    style.tokensJson,
    "",
    `Font files: ${style.fonts.map((f) => `${f.family} -> ${f.file}`).join("; ")}`,
    example
      ? `\nA finished scene in this style and technique, for reference (it uses scene id s1; yours must use ${scene.id} and show this plan, not copy it):\n\`\`\`html\n${example}\n\`\`\``
      : null,
  ]
    .filter((l) => l !== null)
    .join("\n");
  parts.push({ type: "text", text });
  return parts;
}

export interface ComposedScene {
  id: string;
  html: string;
  /** The conversation so far, so repairs keep the model's own context. */
  messages: ChatMessage[];
}

async function ask(
  ctx: ComposeContext,
  scene: Scene,
  messages: ChatMessage[],
  purpose: string,
): Promise<string> {
  const reply = await ctx.provider.complete({
    system: systemPrompt(scene),
    messages,
    maxTokens: 64_000,
    purpose,
  });
  messages.push({ role: "assistant", content: [{ type: "text", text: reply.text }] });
  return reply.text;
}

/** Writes one scene, then fixes static problems (at most `maxAttempts` replies in total). */
export async function composeScene(
  ctx: ComposeContext,
  scene: Scene,
  maxAttempts = 3,
): Promise<ComposedScene> {
  const messages: ChatMessage[] = [{ role: "user", content: composeRequest(ctx, scene) }];
  let reply = await ask(ctx, scene, messages, `compose ${scene.id}`);
  for (let attempt = 1; ; attempt++) {
    let problems: string[];
    let html = "";
    try {
      html = extractHtml(reply);
      problems = staticSceneProblems(
        html,
        scene.id,
        sceneAssetSrcs(ctx.plan, scene),
        sceneMode(ctx.plan, scene) === "overlay",
      );
    } catch (err) {
      problems = [err instanceof Error ? err.message : String(err)];
    }
    if (problems.length === 0) return { id: scene.id, html, messages };
    keepRejected(ctx.rejectedDir, `${scene.id}-attempt-${attempt}`, reply, problems);
    if (attempt >= maxAttempts)
      throw new Error(
        `Scene ${scene.id} still has problems after ${maxAttempts} attempts:\n- ${problems.join("\n- ")}`,
      );
    reply = await repairScene(ctx, scene, messages, problems, `repair ${scene.id}`);
  }
}

/**
 * Below this loaded context (tokens) a repair carries only the scene's request, the latest HTML and its
 * problems: every earlier version kept in the conversation would soon fill a local model's context.
 */
export const COMPACT_REPAIRS_BELOW = 100_000;

/**
 * Sends validation problems back into the scene's conversation and returns the new reply. A provider with a
 * small loaded context (a local model) gets the conversation cut down to the request and the latest reply
 * first; the others keep the whole of it.
 */
export async function repairScene(
  ctx: ComposeContext,
  scene: Scene,
  messages: ChatMessage[],
  problems: string[],
  purpose: string,
): Promise<string> {
  const context = await ctx.provider.loadedContext?.();
  if (context !== undefined && context < COMPACT_REPAIRS_BELOW) {
    const latest = messages.findLast((m) => m.role === "assistant");
    messages.splice(1, messages.length - 1, ...(latest ? [latest] : []));
  }
  messages.push({
    role: "user",
    content: [{ type: "text", text: `${loadPrompt("repair")}- ${problems.join("\n- ")}` }],
  });
  return ask(ctx, scene, messages, purpose);
}
