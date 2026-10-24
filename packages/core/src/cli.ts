#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CliError, USAGE, describeRun, parseCliArgs } from "./cli/args.js";
import { loadDefaults } from "./config.js";
import { formatFps } from "./fps.js";
import { createTextProvider } from "./providers/index.js";
import { PlanSchema } from "./schemas/plan.js";
import { TranscriptSchema } from "./schemas/transcript.js";
import { runPipeline } from "./stages/run.js";
import { loadModelCatalog, usageCost } from "./models.js";
import { ValidationError, renderPlan } from "./stages/render.js";
import { transcribe } from "./stages/transcribe.js";
import { listStyles, loadStyle } from "./styles.js";
import { suggestStyles } from "./stages/suggest.js";
import { createStyle, previewStyle } from "./stages/style-create.js";
import { storyText, writeStory, type Story } from "./stages/story.js";
import { createSpeechProvider, loadSpeechCatalog, narrate } from "./speech/index.js";
import {
  CAPTION_LOOKS,
  correctCaptionWords,
  renderCaptions,
  splitLines,
} from "./captions/index.js";
import { formatOf } from "./format.js";
import { UsageMeter } from "./providers/types.js";

function log(message: string) {
  process.stderr.write(`${message}\n`);
}

function required(value: string | undefined): string {
  if (!value) throw new CliError("Missing --audio.");
  return value;
}

function writeJson(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

async function main(argv: string[]): Promise<number> {
  const args = parseCliArgs(argv, listStyles());
  if (args.command === "help") {
    log(USAGE);
    return 0;
  }
  if (args.command === "models") {
    const provider = createTextProvider(loadDefaults(), {
      provider: args.provider,
      baseURL: args.baseURL,
    });
    provider.preflight?.();
    if (!provider.listModels) throw new CliError(`${provider.name} cannot list models.`);
    const catalog = loadModelCatalog();
    for (const m of await provider.listModels()) {
      const known = catalog.models[m.id];
      const price = known
        ? `  ${known.quality}, $${known.price.input} in / $${known.price.output} out per M tokens`
        : "";
      const flags = [
        m.vision ? "vision" : null,
        m.contextWindow ? `${Math.round(m.contextWindow / 1000)}K` : null,
      ]
        .filter(Boolean)
        .join(", ");
      process.stdout.write(`${m.id}  (${m.displayName}${flags ? `, ${flags}` : ""})${price}\n`);
    }
    return 0;
  }

  if (args.command === "suggest") {
    const defaults = loadDefaults();
    const transcript = args.transcript
      ? TranscriptSchema.parse(JSON.parse(readFileSync(args.transcript, "utf8")))
      : await transcribe({
          audioPath: required(args.audio),
          defaults,
          language: args.language,
          onProgress: log,
        });
    const provider = createTextProvider(defaults, { ...args, purpose: "suggest", onFallback: log });
    provider.preflight?.();
    const usage = new UsageMeter();
    const result = await suggestStyles({
      provider: usage.wrap(provider),
      transcript,
      styles: listStyles().map((name) => loadStyle(name)),
    });
    for (const s of result.suggestions) process.stdout.write(`${s.style}: ${s.reason}\n`);
    const total = usage.total();
    log(
      `Tokens: ${total.inputTokens} in, ${total.outputTokens} out${total.listPriceUsd ? `, about $${total.listPriceUsd.toFixed(3)} at API prices` : ""}`,
    );
    return 0;
  }

  if (args.command === "story") {
    const defaults = loadDefaults();
    const outDir = resolve(args.out);
    mkdirSync(outDir, { recursive: true });
    let story: Story;
    if (args.script) {
      const paragraphs = readFileSync(args.script, "utf8")
        .split(/\n\s*\n/)
        .map((p) => p.replace(/\s+/g, " ").trim())
        .filter(Boolean);
      story = { title: "Script", voice_style: args.tone ?? "clear, warm narrator", paragraphs };
    } else {
      const provider = createTextProvider(defaults, { ...args, onFallback: log });
      provider.preflight?.();
      const usage = new UsageMeter();
      story = await writeStory({
        provider: usage.wrap(provider),
        brief: args.brief,
        durationS: args.durationS,
        language: args.language,
        tone: args.tone,
        onProgress: log,
      });
      const cost = usage.total().listPriceUsd;
      log(`Story: ${story.title}${cost ? `, about $${cost.toFixed(3)} at API prices` : ""}`);
    }
    writeFileSync(join(outDir, "story.json"), `${JSON.stringify(story, null, 2)}\n`);
    process.stdout.write(`${storyText(story)}\n`);
    if (args.noVoice) return 0;
    const speech = createSpeechProvider(defaults, { model: args.speechModel });
    const voice = args.voice ?? defaults.speech.voice;
    const result = await narrate({
      provider: speech,
      text: storyText(story),
      voice,
      style: story.voice_style,
      outFile: join(outDir, "narration.wav"),
      onProgress: log,
    });
    writeFileSync(
      join(outDir, "narration.json"),
      `${JSON.stringify({ voice, model: speech.model, ...result }, null, 2)}\n`,
    );
    const price = loadSpeechCatalog()
      .find((p) => p.id === speech.id)
      ?.models.find((m) => m.id === speech.model)?.price;
    const cost = price
      ? (result.audioTokens * price.outputAudio + result.inputTokens * price.input) / 1e6
      : 0;
    log(
      `Narration: ${result.durationS.toFixed(1)} s, ${voice}${cost ? `, about $${cost.toFixed(4)} at API prices` : ""}`,
    );
    log(result.file);
    return 0;
  }

  if (args.command === "style-create" || args.command === "style-preview") {
    const defaults = loadDefaults();
    const provider = createTextProvider(defaults, { ...args, onFallback: log });
    provider.preflight?.();
    const outDir = resolve(args.out);
    let name = args.command === "style-preview" ? args.style : "";
    const meters: UsageMeter[] = [];
    if (args.command === "style-create") {
      const made = await createStyle({
        description: args.describe,
        references: args.refs,
        provider,
        workDir: outDir,
        ...(args.revise ? { revise: { name: args.revise, note: args.note ?? "" } } : {}),
        onProgress: log,
      });
      meters.push(made.usage);
      name = made.name;
      process.stdout.write(
        `${made.name}: ${made.displayName.tr} / ${made.displayName.en}\n${made.dir}\n`,
      );
      if (made.notes.tr) process.stdout.write(`${made.notes.tr}\n`);
      if (args.noPreview) return 0;
    }
    const preview = await previewStyle({
      name,
      provider,
      outDir: join(outDir, "preview"),
      onProgress: log,
    });
    meters.push(preview.usage);
    process.stdout.write(`${preview.stills.join("\n")}\n`);
    const cost = meters.reduce((sum, m) => sum + (m.total().listPriceUsd || 0), 0);
    log(`Done${cost ? `, about $${cost.toFixed(2)} at API prices` : ""}`);
    return 0;
  }

  if (args.command === "render") {
    const plan = PlanSchema.parse(JSON.parse(readFileSync(args.plan, "utf8")));
    const scenes = Object.fromEntries(
      plan.scenes.map((s) => {
        const file = join(args.scenes, `${s.id}.html`);
        if (!existsSync(file)) throw new CliError(`Missing scene file: ${file}`);
        return [s.id, readFileSync(file, "utf8")];
      }),
    );
    try {
      const result = await renderPlan({
        plan,
        scenes,
        outDir: resolve(args.out),
        stillsOnly: args.stillsOnly,
        onProgress: log,
      });
      writeJson(join(resolve(args.out), "report.json"), result);
      for (const w of result.warnings) log(`warning: ${w.message}`);
      log(`stills: ${result.stills.length}`);
      if (result.output) log(result.output);
      if (result.preview) log(result.preview);
      if (result.sfx) {
        log(`sfx: ${result.sfx.stems.length} stems, peak ${result.sfx.peakDb.toFixed(1)} dBFS`);
        for (const s of result.sfx.skipped) log(`warning: sound skipped, ${s}`);
      }
      log(`timings (ms): ${JSON.stringify(result.timingsMs)}`);
      return 0;
    } catch (err) {
      if (err instanceof ValidationError) {
        for (const f of err.findings)
          log(`- ${f.code ?? "check"}: ${f.message}${f.fixHint ? ` (fix: ${f.fixHint})` : ""}`);
      }
      throw err;
    }
  }

  if (!existsSync(args.audio)) throw new CliError(`Audio file not found: ${args.audio}`);
  const defaults = loadDefaults();

  if (args.command === "transcribe") {
    const started = Date.now();
    const transcript = await transcribe({
      audioPath: args.audio,
      defaults,
      language: args.language,
      onProgress: log,
    });
    writeJson(resolve(args.out), transcript);
    log(
      `${transcript.words.length} words, ${transcript.duration_s.toFixed(2)} s audio, ${((Date.now() - started) / 1000).toFixed(1)} s`,
    );
    log(resolve(args.out));
    return 0;
  }

  if (args.command === "captions") {
    const transcript = await transcribe({
      audioPath: args.audio,
      defaults,
      language: args.language,
      onProgress: log,
    });
    const language = transcript.language ?? args.language ?? "";
    let words = transcript.words;
    const provider = createTextProvider(defaults, { ...args, onFallback: log });
    provider.preflight?.();
    const usage = new UsageMeter();
    const corrected = await correctCaptionWords({
      provider: usage.wrap(provider),
      words,
      language,
      glossary: args.glossary,
      mode: args.mode,
      onProgress: log,
    });
    if (corrected.corrected) words = corrected.words;
    else
      log(
        `The text was not corrected, using the transcript as is${corrected.error ? `: ${corrected.error}` : ""}`,
      );
    const look = CAPTION_LOOKS[args.look];
    const lines = splitLines(words, {
      maxChars: look.maxChars[formatOf(args.size)],
      maxLines: look.maxLines,
    });
    const result = await renderCaptions({
      doc: {
        lines,
        language,
        glossary: args.glossary,
        durationS: transcript.duration_s,
        width: args.size.width,
        height: args.size.height,
        fps: formatFps(args.fps),
        hideSpans: [],
      },
      look: args.look,
      colors: look.colors,
      outDir: resolve(args.out),
      onProgress: log,
    });
    process.stdout.write(`${result.video}\n${result.srt}\n`);
    return 0;
  }

  const outDir = resolve(args.out);
  mkdirSync(outDir, { recursive: true });
  log(`Job: ${describeRun(args)}`);
  writeJson(join(outDir, "job.json"), {
    version: 1,
    audio: resolve(args.audio),
    style: args.style,
    mode: args.mode,
    format: args.format,
    fps: formatFps(args.fps),
    sequence: args.sequence,
    output: args.output,
    language: args.language ?? null,
    note: args.note ?? null,
  });
  const provider = createTextProvider(defaults, args);
  log(
    `Model: ${provider.name} ${provider.model}${provider.billing === "plan" ? " (your Claude plan)" : ""}`,
  );
  provider.preflight?.();
  const transcript = args.transcript
    ? TranscriptSchema.parse(JSON.parse(readFileSync(args.transcript, "utf8")))
    : undefined;
  const started = Date.now();
  try {
    const result = await runPipeline({
      audioPath: args.audio,
      outDir,
      provider,
      defaults,
      language: args.language,
      transcript,
      range: args.range,
      stillsOnly: args.stillsOnly,
      assets: args.images,
      frames: args.frames,
      job: {
        style: args.style,
        mode: args.mode,
        format: args.format,
        width: args.output.width,
        height: args.output.height,
        fps: args.fps,
        handlesFrames: Math.round((20 / 25) * (args.fps.num / args.fps.den)),
        note: args.note,
      },
      onProgress: log,
    });
    const total = result.usage.total();
    const listCost =
      total.listPriceUsd || usageCost(total, loadModelCatalog().models[provider.model]?.price);
    const costText =
      provider.billing === "plan"
        ? `, billed to your Claude plan${listCost ? ` (about $${listCost.toFixed(2)} at API prices)` : ""}`
        : listCost
          ? `, about $${listCost.toFixed(2)}`
          : "";
    log(
      `Done in ${((Date.now() - started) / 1000).toFixed(1)} s, ${result.repairRounds} repair round(s)${costText}`,
    );
    log(
      `Tokens: ${total.inputTokens} in, ${total.cacheWriteTokens ?? 0} cache write, ${total.cacheReadTokens ?? 0} cache read, ${total.outputTokens} out (${result.usage.calls.length} calls)`,
    );
    log(`Stills: ${result.render.stills.join(", ")}`);
    if (result.render.output) log(result.render.output);
    if (result.render.preview) log(`Preview with speech: ${result.render.preview}`);
  } catch (err) {
    if (err instanceof ValidationError) {
      for (const f of err.findings) log(`- ${f.code ?? "check"}: ${f.message}`);
    }
    throw err;
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof CliError) {
      log(`Error: ${err.message}\n\n${USAGE}`);
      process.exit(2);
    }
    log(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
