import { ProviderError, type TextProvider } from "./types.js";

/** A 64x64 PNG filled with one plain red (#E01414; the earlier brick red #D0342C read as brown to MiniMax M3 now and then): the connection test asks the model which colour it sees. */
const RED_SQUARE =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAZElEQVR4nO3PQQ3AIADAQEiQAP614WQieFyW9BS08+4z/mzpgFcNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaB9FjgIIBqGo1wAAAABJRU5ErkJggg==";

export interface ProviderTestResult {
  ok: boolean;
  /** The model answered and named the colour of the picture. */
  vision: boolean;
  model: string;
  ms: number;
  /** What went wrong, in words the editor can act on. */
  message?: string;
}

/**
 * The settings screen's connection test: one short request with a picture, so a wrong key,
 * a wrong address and a model that cannot read images all show up before a job runs.
 */
export async function testProvider(provider: TextProvider): Promise<ProviderTestResult> {
  const started = Date.now();
  try {
    provider.preflight?.();
    const r = await provider.complete({
      system: "You check a connection. Answer with one English word.",
      messages: [
        {
          role: "user",
          content: [
            { type: "image", mediaType: "image/png", base64: RED_SQUARE },
            { type: "text", text: "What colour is this square? One word." },
          ],
        },
      ],
      maxTokens: 300,
      purpose: "connection test",
    });
    const vision = /red|crimson|scarlet|kırmızı/i.test(r.text);
    return {
      ok: true,
      vision,
      model: r.model,
      ms: Date.now() - started,
      ...(vision ? {} : { message: "The model answered but did not see the picture." }),
    };
  } catch (err) {
    return {
      ok: false,
      vision: false,
      model: provider.model,
      ms: Date.now() - started,
      message: err instanceof ProviderError || err instanceof Error ? err.message : String(err),
    };
  }
}
