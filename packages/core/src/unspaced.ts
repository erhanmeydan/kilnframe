/**
 * Scripts written without spaces between words: Chinese, Japanese, Thai, Lao and Burmese. A transcript splits them
 * into words for cutting and timing; text put back together from those words takes no space where a word of these
 * scripts meets another.
 */

/** A character of a script written without spaces (Han, kana, Thai, Lao, Burmese), its stops ("。") included. */
export const UNSPACED =
  /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Thai}\p{scx=Lao}\p{scx=Myanmar}]/u;

/** What goes between two words: nothing where either side of the join is in an unspaced script, else a space. */
export function wordGap(before: string, after: string): string {
  const last = [...before].at(-1) ?? "";
  const first = [...after][0] ?? "";
  return UNSPACED.test(last) || UNSPACED.test(first) ? "" : " ";
}

/** Words written as text: "a b" for spaced languages, "こんにちは世界" for unspaced ones. */
export function joinWords(words: string[]): string {
  let text = "";
  words.forEach((w, i) => {
    text += i === 0 ? w : wordGap(words[i - 1] as string, w) + w;
  });
  return text;
}
