import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ffmpegPath } from "../src/config.js";
import {
  fitMusic,
  generateMusic,
  loadMusicCatalog,
  makeMusic,
  sungWords,
  musicPrompt,
} from "../src/music/index.js";
import { loadDefaults } from "../src/config.js";
import { readFileSync } from "node:fs";
import { loadPalette } from "../src/stages/sfx.js";
import { listStyles, stylesDir } from "../src/styles.js";

function sine(file: string, seconds: number, freq: number, channels = 2) {
  spawnSync(ffmpegPath(), [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${freq}:duration=${seconds}:sample_rate=48000`,
    "-ac",
    String(channels),
    file,
  ]);
}

function seconds(file: string): number {
  const r = spawnSync(ffmpegPath(), ["-i", file, "-f", "null", "-"], { encoding: "utf8" });
  const all = [...r.stderr.matchAll(/time=(\d+):(\d+):([\d.]+)/g)].at(-1);
  return all ? +all[1]! * 3600 + +all[2]! * 60 + +all[3]! : 0;
}

describe("music", () => {
  it("gives every preset style a music brief", () => {
    for (const name of listStyles(stylesDir()))
      expect(loadPalette(name).music, name).toMatch(/BPM/);
    expect(loadMusicCatalog()[0]?.models.map((m) => m.id)).toContain("lyria-3.5");
  });

  it("always asks for an instrumental bed of the right length", () => {
    const p = musicPrompt({ brief: "Soft piano.", subject: "the Moon", durationS: 75 });
    expect(p).toMatch(/^Instrumental only, no vocals/);
    expect(p).toContain("about 1 min 15 s");
    expect(p).toContain("Soft piano.");
    expect(p).toContain("about: the Moon");
  });

  it("sends the prompt to Lyria and reads the audio back", async () => {
    const calls: unknown[] = [];
    const r = await generateMusic({
      apiKey: "k",
      model: "lyria-3.5",
      endpoint: "https://example.invalid",
      prompt: "x",
      fetch: (async (_u: string, init: { body: string }) => {
        calls.push(JSON.parse(init.body));
        return new Response(
          JSON.stringify({
            steps: [
              {
                type: "model_output",
                content: [{ type: "audio", data: "UklGRg==", mime_type: "audio/wav" }],
              },
            ],
          }),
        );
      }) as unknown as typeof fetch,
    });
    expect(r.audio.toString()).toBe("RIFF");
    expect(calls[0]).toMatchObject({
      model: "lyria-3.5",
      input: "x",
      response_format: { type: "audio" },
    });
  });

  it("tells a sung line from the words Whisper imagines in music", () => {
    const at = (...s: number[]) => s.map((start) => ({ start }));
    // a sung line under the promo: one word every 0.3 to 0.5 s
    expect(
      sungWords(at(11, 11.3, 11.6, 11.9, 12.1, 12.5, 12.8, 13.1, 14.1, 14.4)),
    ).toBeGreaterThanOrEqual(6);
    // "I'm going to go to the next video. Thank you." on instrumental music
    expect(sungWords(at(0.3, 12.4, 27.9, 27.9, 28.0, 28.0, 28.0, 28.0, 29.8, 49.4))).toBeLessThan(
      6,
    );
  });

  it("writes the music again when a voice is heard in it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mi-music-voice-"));
    sine(join(dir, "song.wav"), 6, 220);
    sine(join(dir, "voice.wav"), 5, 500, 1);
    const song = readFileSync(join(dir, "song.wav")).toString("base64");
    let requests = 0;
    const heard = [14, 1]; // the first take sings, the second one does not
    const r = await makeMusic({
      defaults: loadDefaults(),
      apiKey: "k",
      brief: "calm",
      narration: join(dir, "voice.wav"),
      durationS: 5,
      outFile: join(dir, "music.wav"),
      fetch: (async () => {
        requests++;
        return new Response(
          JSON.stringify({
            steps: [
              {
                type: "model_output",
                content: [{ type: "audio", data: song, mime_type: "audio/wav" }],
              },
            ],
          }),
        );
      }) as unknown as typeof fetch,
      heardWords: async () => heard.shift() ?? 0,
    });
    expect(requests).toBe(2);
    const price = loadMusicCatalog()[0]!.models.find(
      (m) => m.id === loadDefaults().music.model,
    )!.pricePerSong;
    expect(r.priceUsd).toBeCloseTo(price * 2);
  });

  it("loops a short piece to the narration and ducks it while the voice speaks", () => {
    const dir = mkdtempSync(join(tmpdir(), "mi-music-"));
    sine(join(dir, "raw.wav"), 8, 220);
    // voice for 4 s, then silence for 6 s
    spawnSync(ffmpegPath(), [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=500:duration=4:sample_rate=48000",
      "-af",
      "apad=whole_dur=10",
      "-ac",
      "1",
      join(dir, "voice.wav"),
    ]);
    const r = fitMusic({
      raw: join(dir, "raw.wav"),
      narration: join(dir, "voice.wav"),
      durationS: 10,
      outFile: join(dir, "music.wav"),
      tailS: 1,
    });
    expect(seconds(r.file)).toBeCloseTo(11, 0);
    const level = (st: number) => {
      const out = spawnSync(
        ffmpegPath(),
        ["-ss", String(st), "-t", "1", "-i", r.file, "-af", "volumedetect", "-f", "null", "-"],
        { encoding: "utf8" },
      ).stderr;
      return Number(/mean_volume: (-?[\d.]+)/.exec(out)?.[1]);
    };
    expect(level(1.5)).toBeLessThan(level(6) - 3);
  });
});
