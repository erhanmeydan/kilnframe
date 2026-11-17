// The speech model in a process of its own (runSpeechProcess and runSpeechParts in transcribe.ts): when it
// ends, all the memory the model took goes back to the system.
import { voteLanguage } from "./transcribe-parts.js";
import {
  languageScores,
  loadSpeechModel,
  readSamples,
  recognize,
  transcribeHere,
  type SpeechModelReply,
  type SpeechModelRequest,
  type SpeechPartsMessage,
  type SpeechPartsReply,
  type SpeechPartsRequest,
} from "./transcribe.js";

const send = (m: SpeechModelReply | SpeechPartsReply) =>
  new Promise<void>((resolve) =>
    process.send ? process.send(m, undefined, {}, () => resolve()) : resolve(),
  );
const progress = (message: string) => void send({ type: "progress", message });
const failed = (err: unknown) =>
  send({
    type: "failed",
    name: err instanceof Error ? err.name : "Error",
    message: err instanceof Error ? err.message : String(err),
  });

/** Reads the parts the coordinator hands out, one at a time, with one model. */
async function readParts(request: SpeechPartsRequest): Promise<void> {
  const asr = await loadSpeechModel(request.defaults, progress, request.threads);
  let queue = Promise.resolve();
  process.on("message", (m: SpeechPartsMessage) => {
    queue = queue
      .then(async () => {
        if (m.type === "end") process.exit(0);
        if (m.type === "detect") {
          // 30 seconds at each window, voted, as Whisper itself decides one window
          const windows = [];
          for (const start of m.starts)
            windows.push(
              await languageScores(
                asr,
                readSamples(request.pcmPath, start, start + 30 * request.sampleRate),
              ),
            );
          const { language, probability } = voteLanguage(windows);
          await send({ type: "language", language, probability });
        } else if (m.type === "piece") {
          const audio = readSamples(request.pcmPath, m.start, m.end);
          const chunks = await recognize(asr, audio, request.defaults, m.language);
          await send({ type: "piece", index: m.index, chunks });
        }
      })
      .catch((err: unknown) => failed(err).finally(() => process.exit(0)));
  });
  await send({ type: "ready" });
}

process.once("message", (request: SpeechModelRequest) => {
  if (request.kind === "parts") {
    readParts(request).catch((err: unknown) => failed(err).finally(() => process.exit(0)));
    return;
  }
  const work =
    request.kind === "transcribe"
      ? transcribeHere({ ...request, onProgress: progress }).then((transcript) => ({ transcript }))
      : loadSpeechModel(request.defaults, progress).then(() => ({}));
  work
    .then((r) => send({ type: "done", ...r }))
    .catch((err: unknown) => failed(err))
    .finally(() => process.exit(0));
});
