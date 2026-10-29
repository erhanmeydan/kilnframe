// A long talk for size tests; a helper, not a test file (importing a test file would run its tests twice).
import type { CaptionWord } from "../src/captions/types.js";

/** About three and a half words a second with Whisper's 10 ms times: some 16,000 words in 90 minutes. */
export function longWords(minutes = 90): CaptionWord[] {
  const vocabulary = [
    "Bugün",
    "Topview'i",
    "deneyeceğiz.",
    "Hadi",
    "başlayalım,",
    "çünkü",
    "şöyle",
  ];
  const words: CaptionWord[] = [];
  let t = 0.2;
  for (let i = 0; t < minutes * 60 - 1; i++) {
    const length = 0.16 + (i % 5) * 0.03;
    words.push({
      text: vocabulary[i % vocabulary.length]!,
      start: Math.round(t * 100) / 100,
      end: Math.round((t + length) * 100) / 100,
    });
    t += length + (i % 15 === 14 ? 0.6 : 0.04);
  }
  return words;
}
