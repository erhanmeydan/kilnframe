import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { makeCloneVoice } from "../src/clone-voice.js";

const entry = { id: "elevenlabs", keyName: "elevenlabs", endpoint: "https://x" };

describe("speech.clone dry run", () => {
  it("cuts the sample and never calls ElevenLabs, even with a key", async () => {
    const clone = vi.fn();
    const cut = vi.fn(() => ({ file: "/j/voice-fix/voice-sample.wav", durationS: 91 }));
    const run = makeCloneVoice({
      getKey: async () => "secret",
      catalog: (() => [entry]) as never,
      cut: cut as never,
      clone: clone as never,
    });
    const out = await run({
      audioPath: join("/j", "voice-fix", "window.wav"),
      spans: [{ startS: 1, endS: 92 }],
      name: "Kilnframe: Talk",
      removeNoise: true,
      dryRun: true,
    });
    expect(clone).not.toHaveBeenCalled();
    expect(cut).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({
      voice: "",
      sample: "/j/voice-fix/voice-sample.wav",
      durationS: 91,
    });
  });

  it("needs no key for a dry run, but a real clone does", async () => {
    const clone = vi.fn();
    const cut = vi.fn(() => ({ file: "/j/voice-fix/voice-sample.wav", durationS: 40 }));
    const run = makeCloneVoice({
      getKey: async () => undefined,
      catalog: (() => [entry]) as never,
      cut: cut as never,
      clone: clone as never,
    });
    const o = { audioPath: "/j/voice-fix/window.wav", name: "n", removeNoise: false };
    await expect(run({ ...o, dryRun: true })).resolves.toMatchObject({ voice: "" });
    await expect(run(o)).rejects.toThrow("ElevenLabs key");
    expect(clone).not.toHaveBeenCalled();
  });
});
