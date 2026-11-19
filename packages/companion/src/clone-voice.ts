import { readFileSync } from "node:fs";
import {
  cloneElevenLabsVoice,
  cloneLocalVoice,
  cutVoiceSample,
  loadSpeechCatalog,
  localSpeechBaseUrl,
} from "@kilnframe/core";
import { voiceSampleFile } from "./panel-support.js";

export interface CloneVoiceOptions {
  audioPath: string;
  rangeStartS?: number;
  rangeEndS?: number;
  spans?: { startS: number; endS: number }[];
  name: string;
  removeNoise: boolean;
  dryRun?: boolean;
  /** "elevenlabs" (default) or "local": a speech server that takes POST /v1/audio/voices. */
  provider?: string | undefined;
  baseURL?: string | undefined;
}

export interface CloneVoiceDeps {
  getKey: (name: string) => Promise<string | undefined>;
  catalog?: typeof loadSpeechCatalog;
  cut?: typeof cutVoiceSample;
  clone?: typeof cloneElevenLabsVoice;
  cloneLocal?: typeof cloneLocalVoice;
}

/**
 * Cuts the sample for a voice clone and, unless it is a dry run, clones it in the editor's ElevenLabs account
 * or on their local speech server (no key needed there).
 */
export function makeCloneVoice(deps: CloneVoiceDeps) {
  const catalog = deps.catalog ?? loadSpeechCatalog;
  const cut = deps.cut ?? cutVoiceSample;
  const clone = deps.clone ?? cloneElevenLabsVoice;
  const cloneLocal = deps.cloneLocal ?? cloneLocalVoice;
  return async (o: CloneVoiceOptions) => {
    if (o.provider === "local") {
      const local = catalog().find((p) => p.id === "local");
      const sample = cut({
        input: o.audioPath,
        ...(o.spans ? { spans: o.spans } : { startS: o.rangeStartS ?? 0, endS: o.rangeEndS ?? 0 }),
        outFile: voiceSampleFile(o.audioPath),
      });
      if (o.dryRun)
        return {
          voice: "",
          name: o.name,
          durationS: sample.durationS,
          requiresVerification: false,
          sample: sample.file,
        };
      const made = await cloneLocal({
        baseUrl: localSpeechBaseUrl({ baseUrl: o.baseURL, fallback: local?.endpoint }),
        apiKey: await deps.getKey(local?.keyName ?? "local"),
        name: o.name,
        audio: readFileSync(sample.file),
      });
      return {
        voice: made.voiceId,
        name: o.name,
        durationS: sample.durationS,
        requiresVerification: false,
      };
    }
    const entry = catalog().find((p) => p.id === "elevenlabs");
    const key = await deps.getKey(entry?.keyName ?? "elevenlabs");
    // a dry run only cuts the sample, so it needs no key
    if (!o.dryRun && (!entry || !key))
      throw new Error("Voice cloning needs an ElevenLabs key. Add it in the settings.");
    // the sample goes in the job's voice-fix folder (cutVoiceSample makes it), where audio.play finds it
    const sample = cut({
      input: o.audioPath,
      ...(o.spans ? { spans: o.spans } : { startS: o.rangeStartS ?? 0, endS: o.rangeEndS ?? 0 }),
      outFile: voiceSampleFile(o.audioPath),
    });
    if (o.dryRun)
      return {
        voice: "",
        name: o.name,
        durationS: sample.durationS,
        requiresVerification: false,
        sample: sample.file,
      };
    if (!entry || !key) throw new Error("Voice cloning needs an ElevenLabs key.");
    const made = await clone({
      apiKey: key,
      endpoint: entry.endpoint,
      name: o.name,
      audio: readFileSync(sample.file),
      removeBackgroundNoise: o.removeNoise,
    });
    return {
      voice: made.voiceId,
      name: o.name,
      durationS: sample.durationS,
      requiresVerification: made.requiresVerification,
    };
  };
}
