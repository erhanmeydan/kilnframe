import {
  createSpeechProvider,
  createStyle,
  loadPalette,
  makeMusic,
  createTextProvider,
  cutAudio,
  decodeAudio,
  loadMusicCatalog,
  makeScore,
  rewriteSectionPrompt,
  NoSpeechError,
  splitLong,
  transcribe,
  writeMusicPlan,
  type Transcript,
  loadSpeechCatalog,
  narrate,
  planParts,
  readTranscript,
  UsageMeter,
  writeStory,
  addUsage,
  formatOf,
  loadDefaults,
  loadModelCatalog,
  outputSize,
  parseFps,
  parseSize,
  previewStyle,
  readUsageSummary,
  recomposeScene,
  renderApproved,
  runPipeline,
  type Plan,
  type RenderPlanResult,
} from "@kilnframe/core";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stillImages } from "./panel-support.js";
import type { KeyStore } from "./keys.js";
import type {
  JobParams,
  MusicMakeJobParams,
  StoryVoiceJobParams,
  StyleJobParams,
} from "./protocol.js";
import type { JobRunner } from "./queue.js";

/** The story text next to a narration, when there is one; a missing file only means no correction. */
function readScript(path: string | undefined): string | undefined {
  if (!path || !existsSync(path)) return undefined;
  return readFileSync(path, "utf8");
}

/** Runs the core pipeline for a panel job, with the API key read from the keychain. */
export function pipelineRunner(keys: KeyStore): JobRunner {
  return async (params: JobParams, events) => {
    const defaults = loadDefaults();
    if (params.kind === "story-voice") return storyVoiceJob(params, keys, events.progress);
    if (params.kind === "music-make")
      return musicMakeJob(params, keys, events.progress, events.signal);
    if (params.kind === "parts") {
      const r = await planParts({
        audioPath: params.audioPath,
        range:
          params.rangeStartS !== undefined && params.rangeEndS !== undefined
            ? { startS: params.rangeStartS, endS: params.rangeEndS }
            : undefined,
        outDir: params.outDir,
        defaults,
        language: params.language,
        options: params.targetS
          ? { targetS: params.targetS, minS: params.targetS / 2, maxS: params.targetS * 1.5 }
          : {},
        script: readScript(params.scriptPath),
        onProgress: events.progress,
      });
      return { kind: "parts", ...r };
    }
    const providerName = params.provider ?? defaults.text.provider;
    // "auto" falls back to the Anthropic API, so its key is the Anthropic one
    const apiKey = await keys.get(providerName === "auto" ? "anthropic" : providerName);
    const provider = createTextProvider(defaults, {
      provider: providerName,
      model: params.model,
      baseURL: params.baseURL,
      apiKey,
    });
    if (params.kind === "style") return styleJob(params, provider, events.progress);
    if (params.kind === "music-plan") {
      mkdirSync(params.outDir, { recursive: true });
      const ranged = params.rangeStartS !== undefined && params.rangeEndS !== undefined;
      const speech = ranged ? join(params.outDir, "range.wav") : params.audioPath;
      if (ranged) await cutAudio(params.audioPath, speech, params.rangeStartS!, params.rangeEndS!);
      let transcript: Transcript | null = null;
      try {
        transcript = await transcribe({ audioPath: speech, defaults, onProgress: events.progress });
        writeFileSync(join(params.outDir, "transcript.json"), JSON.stringify(transcript, null, 2));
      } catch (err) {
        // music under B-roll or a silent stretch: planned without speech
        if (!(err instanceof NoSpeechError)) throw err;
      }
      const durationS = ranged
        ? params.rangeEndS! - params.rangeStartS!
        : (transcript?.duration_s ?? (await decodeAudio(speech)).length / 16_000);
      const usage = new UsageMeter();
      const plan = await writeMusicPlan({
        provider: usage.wrap(provider),
        transcript,
        durationS,
        note: params.note,
        language: params.language,
        frames: params.frames,
        onProgress: events.progress,
      });
      writeFileSync(join(params.outDir, "music-plan.json"), JSON.stringify(plan, null, 2));
      return {
        kind: "music-plan",
        plan,
        speechFile: speech,
        durationS,
        listPriceUsd: usage.total().listPriceUsd || 0,
        billing: provider.billing ?? "api",
      };
    }
    if (params.kind === "story-write") {
      const usage = new UsageMeter();
      const story = await writeStory({
        provider: usage.wrap(provider),
        brief: params.brief,
        durationS: params.durationS,
        language: params.language,
        tone: params.tone,
        revise: params.revise,
        onProgress: events.progress,
      });
      return {
        kind: "story-write",
        story,
        listPriceUsd: usage.total().listPriceUsd || 0,
        billing: provider.billing ?? "api",
      };
    }
    const fps = parseFps(params.fps);
    const fpsValue = fps.num / fps.den;
    // what the panel needs: placement data, and the stills as small images for the review screen
    const panelResult = (plan: Plan, render: RenderPlanResult) => ({
      outDir: params.outDir,
      fps: params.fps,
      handlesSeconds: plan.handles_frames / fpsValue,
      durationSeconds: plan.duration_frames / fpsValue,
      output: render.output,
      preview: render.preview,
      sfxMix: render.sfx?.mix ?? null,
      stills: render.stills,
      stillImages: stillImages(
        render.stills,
        plan.scenes.map((sc) => sc.id),
      ),
      plan,
      // the job's tokens and cost so far, for the line under the placed insert
      cost: readUsageSummary(params.outDir),
    });
    if (params.action === "render") {
      const { plan, render } = await renderApproved({
        outDir: params.outDir,
        onProgress: events.progress,
      });
      return panelResult(plan, render);
    }
    if (params.action === "recompose") {
      if (!params.sceneId) throw new Error("recompose needs a sceneId");
      const r = await recomposeScene({
        outDir: params.outDir,
        sceneId: params.sceneId,
        note: params.note ?? "",
        provider,
        defaults,
        onProgress: events.progress,
      });
      // the scene made again is part of the job's cost
      addUsage(params.outDir, {
        model: provider.model,
        billing: provider.billing ?? "api",
        calls: r.usage.calls,
        price:
          loadModelCatalog().models[provider.model]?.price ??
          (await provider.modelPrice?.().catch(() => undefined)),
      });
      return {
        ...panelResult(r.plan, r.render),
        usage: r.usage.total(),
        repairRounds: r.repairRounds,
      };
    }
    const sequence = parseSize(params.sequenceSize);
    const format = params.format ?? formatOf(sequence);
    const size = outputSize(sequence, format);
    const result = await runPipeline({
      audioPath: params.audioPath,
      outDir: params.outDir,
      provider,
      defaults,
      language: params.language,
      range:
        params.rangeStartS !== undefined && params.rangeEndS !== undefined
          ? { startS: params.rangeStartS, endS: params.rangeEndS }
          : undefined,
      transcript: params.transcriptPath ? readTranscript(params.transcriptPath) : undefined,
      script: readScript(params.scriptPath),
      stillsOnly: params.stillsOnly ?? false,
      assets: params.assets ?? [],
      frames: params.frames ?? [],
      job: {
        style: params.style,
        mode: params.mode,
        format,
        width: size.width,
        height: size.height,
        fps,
        handlesFrames: Math.round((20 / 25) * (fps.num / fps.den)),
        note: params.note,
        part: params.part,
      },
      onProgress: events.progress,
    });
    return {
      ...panelResult(result.plan, result.render),
      usage: result.usage.total(),
      repairRounds: result.repairRounds,
    };
  };
}

/** Makes or revises one of the editor's styles, then renders its three-scene preview. */
async function styleJob(
  params: StyleJobParams,
  provider: ReturnType<typeof createTextProvider>,
  progress: (message: string) => void,
) {
  const work = join(
    process.env.KILNFRAME_HOME ?? join(homedir(), ".kilnframe"),
    "cache",
    "style-jobs",
    `${Date.now()}`,
  );
  mkdirSync(work, { recursive: true });
  const made = await createStyle({
    description: params.description,
    references: params.references,
    provider,
    workDir: work,
    ...(params.revise ? { revise: { name: params.revise, note: params.note ?? "" } } : {}),
    onProgress: progress,
  });
  const preview = await previewStyle({
    name: made.name,
    provider,
    outDir: join(work, "preview"),
    onProgress: progress,
  });
  const total = (made.usage.total().listPriceUsd || 0) + (preview.usage.total().listPriceUsd || 0);
  return {
    kind: "style",
    name: made.name,
    displayName: made.displayName,
    notes: made.notes,
    stillImages: stillImages(preview.stills, ["s1", "s2", "s3"]),
    listPriceUsd: total,
    billing: provider.billing ?? "api",
  };
}

/** Reads the approved narration aloud into the job folder (story.txt and narration.wav). */
async function storyVoiceJob(
  params: StoryVoiceJobParams,
  keys: KeyStore,
  progress: (message: string) => void,
) {
  const defaults = loadDefaults();
  const speech = createSpeechProvider(defaults, {
    model: params.speechModel,
    apiKey: await keys.get(defaults.speech.provider),
  });
  mkdirSync(params.outDir, { recursive: true });
  writeFileSync(join(params.outDir, "story.txt"), `${params.text}\n`);
  const result = await narrate({
    provider: speech,
    text: params.text,
    voice: params.voice,
    style: params.style,
    outFile: join(params.outDir, "narration.wav"),
    onProgress: progress,
  });
  writeFileSync(
    join(params.outDir, "narration.json"),
    `${JSON.stringify({ title: params.title, voice: params.voice, model: speech.model, ...result }, null, 2)}\n`,
  );
  const price = loadSpeechCatalog()
    .find((p) => p.id === speech.id)
    ?.models.find((m) => m.id === speech.model)?.price;
  let music: { file: string; priceUsd: number } | null = null;
  if (params.music) {
    const mood =
      (params.music.style ? loadPalette(params.music.style).music : undefined) ??
      `A calm, warm documentary score that fits a narration read in this manner: ${params.style ?? "clear and warm"}.`;
    music = await makeMusic({
      defaults,
      apiKey: (await keys.get(defaults.music.provider)) ?? "",
      brief: mood,
      subject: params.music.subject ?? params.title,
      narration: result.file,
      durationS: result.durationS,
      outFile: join(params.outDir, "music.wav"),
      onProgress: progress,
    });
  }
  return {
    kind: "story-voice",
    music: music?.file ?? null,
    musicPriceUsd: music?.priceUsd ?? 0,
    file: result.file,
    durationS: result.durationS,
    chunks: result.chunks,
    listPriceUsd: price
      ? (result.audioTokens * price.outputAudio + result.inputTokens * price.input) / 1e6
      : 0,
  };
}

/** The Music tab's second step: Lyria pieces made into one clip per section under the speech. */
async function musicMakeJob(
  params: MusicMakeJobParams,
  keys: KeyStore,
  progress: (message: string) => void,
  signal?: AbortSignal,
) {
  const defaults = loadDefaults();
  const provider = loadMusicCatalog().find((p) => p.id === defaults.music.provider);
  if (!provider) throw new Error(`No music provider ${defaults.music.provider}`);
  const transcriptFile = join(params.outDir, "transcript.json");
  const words = existsSync(transcriptFile)
    ? (JSON.parse(readFileSync(transcriptFile, "utf8")) as Transcript).words
    : [];
  // a section joined in the panel may be longer than one Lyria piece: split again here
  let plan = splitLong(params.plan);
  const notes = Object.entries(params.notes ?? {}).filter(([, note]) => note.trim());
  // the notes are rewritten by the text model: its price goes into the music spend too
  const usage = new UsageMeter();
  let billing: string = "api";
  if (notes.length) {
    progress("Rewriting the music for your notes");
    const name = params.provider ?? defaults.text.provider;
    const text = createTextProvider(defaults, {
      provider: name,
      model: params.model,
      baseURL: params.baseURL,
      apiKey: await keys.get(name === "auto" ? "anthropic" : name),
    });
    billing = text.billing ?? "api";
    const metered = usage.wrap(text);
    for (const [id, note] of notes) {
      const prompt = await rewriteSectionPrompt({ provider: metered, plan, sectionId: id, note });
      plan = { ...plan, sections: plan.sections.map((s) => (s.id === id ? { ...s, prompt } : s)) };
    }
  }
  const r = await makeScore({
    signal,
    plan,
    words,
    rangeDurationS: params.durationS,
    speechFile: params.speechFile ?? null,
    outDir: params.outDir,
    slider: params.slider,
    apiKey: (await keys.get(provider.keyName)) ?? "",
    endpoint: provider.endpoint,
    model: defaults.music.model,
    only: params.only,
    onProgress: progress,
  });
  return {
    kind: "music-make",
    plan,
    ...r,
    textPriceUsd: usage.total().listPriceUsd || 0,
    billing,
  };
}
