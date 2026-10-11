/**
 * Speech providers for story mode: text in, mono 16-bit PCM
 * out. Keys come from the keychain through the caller, like the text providers.
 */

export interface SpeechRequest {
  text: string;
  voice: string;
  /** How to read it, in natural language: "calm and warm, documentary narrator". */
  style?: string | undefined;
}

export interface SpeechResult {
  /** Mono 16-bit little-endian PCM samples. */
  pcm: Buffer;
  sampleRate: number;
  /** Audio tokens billed, when the provider reports or implies them. */
  audioTokens: number;
  inputTokens: number;
}

export interface SpeechProvider {
  readonly id: string;
  readonly model: string;
  synthesize(req: SpeechRequest): Promise<SpeechResult>;
}

export class SpeechError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
    /** How long the provider asked to wait (a rate limit), when it said. */
    readonly retryAfterS?: number,
  ) {
    super(message);
    this.name = "SpeechError";
  }
}

/** The samples of a PCM WAV file (the "data" chunk) and its sample rate; mono 16-bit expected. */
export function wavPcm(wav: Buffer): { pcm: Buffer; sampleRate: number; channels: number } {
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE")
    throw new SpeechError("The speech service did not return a WAV file.");
  let off = 12;
  let sampleRate = 0;
  let channels = 1;
  while (off + 8 <= wav.length) {
    const id = wav.toString("ascii", off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    if (id === "fmt ") {
      channels = wav.readUInt16LE(off + 10);
      sampleRate = wav.readUInt32LE(off + 12);
    } else if (id === "data") {
      // some streams write 0 or 0xFFFFFFFF as the data size; then the data runs to the end
      const end = size && size !== 0xffffffff ? Math.min(wav.length, off + 8 + size) : wav.length;
      return { pcm: wav.subarray(off + 8, end), sampleRate, channels };
    }
    off += 8 + size + (size % 2);
  }
  throw new SpeechError("The WAV from the speech service has no audio data.");
}

/** A mono 16-bit PCM WAV file. */
export function pcmWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
