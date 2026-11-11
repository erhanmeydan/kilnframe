// The speech model in a process of its own (runSpeechProcess in transcribe.ts): when it ends, all the
// memory the model took goes back to the system.
import {
  loadSpeechModel,
  transcribeHere,
  type SpeechModelReply,
  type SpeechModelRequest,
} from "./transcribe.js";

const send = (m: SpeechModelReply) =>
  new Promise<void>((resolve) =>
    process.send ? process.send(m, undefined, {}, () => resolve()) : resolve(),
  );
const progress = (message: string) => void send({ type: "progress", message });

process.once("message", (request: SpeechModelRequest) => {
  const work =
    request.kind === "transcribe"
      ? transcribeHere({ ...request, onProgress: progress }).then((transcript) => ({ transcript }))
      : loadSpeechModel(request.defaults, progress).then(() => ({}));
  work
    .then((r) => send({ type: "done", ...r }))
    .catch((err: unknown) =>
      send({
        type: "failed",
        name: err instanceof Error ? err.name : "Error",
        message: err instanceof Error ? err.message : String(err),
      }),
    )
    .finally(() => process.exit(0));
});
