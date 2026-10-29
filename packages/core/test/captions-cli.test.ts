import { describe, expect, it } from "vitest";
import { CliError, parseCliArgs } from "../src/cli/args.js";

const base = [
  "captions",
  "--audio",
  "a.wav",
  "--style",
  "loud",
  "--size",
  "1080x1920",
  "--fps",
  "25",
  "--out",
  "o",
];

describe("kilnframe captions arguments", () => {
  it("reads the look, size, rate, glossary and spoken mode", () => {
    const args = parseCliArgs([...base, "--glossary", "TopView,Claude", "--spoken"], []);
    expect(args).toMatchObject({
      command: "captions",
      audio: "a.wav",
      look: "loud",
      size: { width: 1080, height: 1920 },
      fps: { num: 25, den: 1 },
      out: "o",
      glossary: ["TopView", "Claude"],
      mode: "spoken",
    });
  });

  it("defaults to the written mode and an empty glossary", () => {
    expect(parseCliArgs(base, [])).toMatchObject({ mode: "written", glossary: [] });
  });

  it("passes the provider flags through", () => {
    const args = parseCliArgs([...base, "--provider", "openai-compatible", "--model", "m"], []);
    expect(args).toMatchObject({ provider: "openai-compatible", model: "m" });
  });

  it("names the nine looks for an unknown style", () => {
    const bad = base.map((a) => (a === "loud" ? "nope" : a));
    let error: unknown;
    try {
      parseCliArgs(bad, []);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(CliError);
    const message = (error as Error).message;
    expect(message).toContain('"nope"');
    for (const id of [
      "kil-lacivert",
      "loud",
      "dinamik",
      "hap",
      "karaoke",
      "daktilo",
      "sakin",
      "bant",
      "editoryal",
    ])
      expect(message).toContain(id);
  });
});
