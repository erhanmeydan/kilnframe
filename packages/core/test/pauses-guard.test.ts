import { expect, test } from "vitest";
import {
  SILENCE_KEEP_MIN_S,
  SILENCE_KEEP_MIN_SHARE,
  SILENCE_KEEP_SHARE_UNDER_S,
  emptiedBySilence,
} from "../src/pauses/guard.js";

test("pauses empty a recording when they leave under 1 s of it, or under 2 % of it while that is under 3 s", () => {
  expect([SILENCE_KEEP_MIN_S, SILENCE_KEEP_MIN_SHARE, SILENCE_KEEP_SHARE_UNDER_S]).toEqual([
    1, 0.02, 3,
  ]);
  expect(emptiedBySilence(0.13, 30)).toBe(true);
  expect(emptiedBySilence(0.99, 30)).toBe(true);
  expect(emptiedBySilence(1, 30)).toBe(false);
  // 2 % of a minute is 1.2 s
  expect(emptiedBySilence(1.1, 60)).toBe(true);
  expect(emptiedBySilence(1.2, 60)).toBe(false);
  // 2 % of 20 minutes is 24 s, but the share counts only under 3 s
  expect(emptiedBySilence(2.9, 1200)).toBe(true);
  expect(emptiedBySilence(3, 1200)).toBe(false);
  expect(emptiedBySilence(40, 1200)).toBe(false);
  // a recording shorter than a second: anything cut from it is too much
  expect(emptiedBySilence(0.5, 0.5)).toBe(false);
  expect(emptiedBySilence(0.4, 0.5)).toBe(true);
});
