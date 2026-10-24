import { describe, expect, it } from "vitest";
import { msTimes, packLines, unpackLines } from "../src/captions/pack.js";
import { retimeLine, splitLines } from "../src/captions/lines.js";
import type { CaptionLine } from "../src/captions/types.js";
import { longWords } from "./long-talk.js";

describe("packed caption lines", () => {
  const words = longWords(2);
  const lines = splitLines(words, { maxChars: 32, maxLines: 2 });
  // an edited line: new words share the time by character count, with long decimals
  lines[3] = retimeLine(lines[3]!, "Bambaşka bir cümle burada")!;
  lines[5] = { ...lines[5]!, changed: true };

  it("gives back exactly the lines it was given", () => {
    const packed = packLines(lines);
    // Whisper's lines go as milliseconds, the edited one as it is
    expect(packed[0]!.d).toBeDefined();
    expect(packed[3]!.m).toBeDefined();
    expect(unpackLines(JSON.parse(JSON.stringify(packed)))).toEqual(lines);
  });

  it("writes a line's text only when it is not its words joined", () => {
    const text: CaptionLine = {
      start: 0,
      end: 1,
      text: "Merhaba  dünya",
      words: [
        { text: "Merhaba", start: 0, end: 0.5 },
        { text: "dünya", start: 0.5, end: 1 },
      ],
      changed: false,
    };
    const [plain] = packLines([{ ...text, text: "Merhaba dünya" }]);
    expect(plain).not.toHaveProperty("t");
    expect(unpackLines(packLines([text]))).toEqual([text]);
  });

  it("rounds every time to milliseconds", () => {
    const rounded = msTimes(lines);
    expect(rounded[3]!.words[1]!.start).toBe(Math.round(lines[3]!.words[1]!.start * 1000) / 1000);
    expect(rounded[0]).toEqual(lines[0]);
    expect(unpackLines(packLines(rounded))).toEqual(rounded);
  });

  it("keeps a 90-minute talk well under the socket's old 1 MiB", () => {
    const all = splitLines(longWords(90), { maxChars: 32, maxLines: 2 });
    expect(all.flatMap((l) => l.words).length).toBeGreaterThan(15_000);
    const full = Buffer.byteLength(JSON.stringify(all));
    const packed = Buffer.byteLength(JSON.stringify(packLines(all)));
    console.log(
      `90 min: ${all.flatMap((l) => l.words).length} words, ${all.length} lines, full ${full} B, packed ${packed} B`,
    );
    expect(packed).toBeLessThan(512 * 1024);
  });
});
