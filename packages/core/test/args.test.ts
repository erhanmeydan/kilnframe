import { describe, expect, it } from "vitest";
import { outputSize } from "../src/index.js";
import { CliError, parseCliArgs as parse } from "../src/cli/args.js";

const STYLES = ["kil-lacivert", "flat-infografik"];
const base = [
  "run",
  "--audio",
  "a.wav",
  "--style",
  "kil-lacivert",
  "--fps",
  "30000/1001",
  "--out",
  "out",
];

describe("outputSize", () => {
  it("derives every format from the sequence's short edge", () => {
    const seq = { width: 1920, height: 1080 };
    expect(outputSize(seq, "landscape")).toEqual({ width: 1920, height: 1080 });
    expect(outputSize(seq, "portrait")).toEqual({ width: 1080, height: 1920 });
    expect(outputSize(seq, "square")).toEqual({ width: 1080, height: 1080 });
    expect(outputSize({ width: 3840, height: 2160 }, "portrait")).toEqual({
      width: 2160,
      height: 3840,
    });
    expect(outputSize({ width: 1080, height: 1350 }, "landscape")).toEqual({
      width: 1920,
      height: 1080,
    });
  });
});

describe("parseCliArgs", () => {
  it("defaults the format to the sequence's own format and the mode to fullscreen", () => {
    const args = parse([...base, "--size", "1080x1920"], STYLES);
    expect(args).toMatchObject({ command: "run", format: "portrait", mode: "fullscreen" });
    if (args.command === "run") expect(args.output).toEqual({ width: 1080, height: 1920 });
  });

  it("lets the user choose another format", () => {
    const args = parse([...base, "--size", "1920x1080", "--format", "square"], STYLES);
    if (args.command !== "run") throw new Error("expected run");
    expect(args.output).toEqual({ width: 1080, height: 1080 });
  });

  it("explains bad input", () => {
    expect(() => parse([...base, "--size", "1920x1080", "--format", "wide"], STYLES)).toThrow(
      /Use one of/,
    );
    expect(() =>
      parse([...base.slice(0, 4), "nope", ...base.slice(5), "--size", "1920x1080"], STYLES),
    ).toThrow(/Unknown style "nope"/);
    expect(() => parse(["run", "--audio", "a.wav"], STYLES)).toThrow(CliError);
    expect(() => parse([...base, "--size", "1920x1080", "--bogus", "1"], STYLES)).toThrow(CliError);
    expect(() => parse(["publish"], STYLES)).toThrow(/Unknown command/);
    expect(() => parse(["render"], STYLES)).toThrow(/Missing --plan/);
  });

  it("parses transcribe with defaults", () => {
    expect(parse(["transcribe", "--audio", "a.wav"], STYLES)).toEqual({
      command: "transcribe",
      audio: "a.wav",
      out: "transcript.json",
      language: undefined,
    });
  });
});
