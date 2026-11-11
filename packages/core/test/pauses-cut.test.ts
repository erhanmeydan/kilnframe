import { expect, test } from "vitest";
import {
  SILENCE_PAD_S,
  cutPauses,
  leadPadS,
  planPauseCuts,
  silenceGapS,
  silencePadS,
  tailPadS,
} from "../src/pauses/cut.js";

test("silenceGapS runs from 1.2 s at strictness 0 to 0.775 s at the middle, and on to a jump cut at Tight", () => {
  expect(silenceGapS(0)).toBe(1.2);
  expect(silenceGapS(0.5)).toBeCloseTo(0.775);
  expect(silenceGapS(1)).toBeCloseTo(0.12);
  expect(SILENCE_PAD_S).toBe(0.15);
  // the pad beside a cut shrinks only past the middle
  expect(silencePadS(0.3)).toBe(0.15);
  expect(silencePadS(1)).toBeCloseTo(0.05);
  // a piece starts close to its first word at Tight; a word's fading end keeps most of its pad
  expect(leadPadS(0.5)).toBeCloseTo(0.05);
  expect(leadPadS(1)).toBeCloseTo(0.03);
  expect(tailPadS(0.5)).toBeCloseTo(0.05);
  expect(tailPadS(1)).toBeCloseTo(0.03);
});

test("strictness outside 0..1 is clamped", () => {
  expect(silenceGapS(-1)).toBe(silenceGapS(0));
  expect(silenceGapS(2)).toBeCloseTo(silenceGapS(1));
  expect(silencePadS(-1)).toBe(silencePadS(0));
  expect(leadPadS(5)).toBeCloseTo(leadPadS(1));
  expect(tailPadS(5)).toBeCloseTo(tailPadS(1));
  const speech: [number, number][] = [
    [1, 2],
    [2.3, 3],
  ];
  expect(cutPauses(speech, 3, 7)).toEqual(cutPauses(speech, 3, 1));
  expect(cutPauses(speech, 3, -3)).toEqual(cutPauses(speech, 3, 0));
});

test("pauses are cut from the speech alone, padded short before speech and a little longer after it", () => {
  const cuts = cutPauses(
    [
      [1, 2],
      [2.3, 3],
      [5, 6],
    ],
    8,
    0.5,
  );
  // 0-1 (the start needs no pad), 3-5, 6-8; the 0.3 s breath stays
  expect(cuts).toEqual([
    { startS: 0, endS: +(1 - leadPadS(0.5)).toFixed(3) },
    { startS: +(3 + tailPadS(0.5)).toFixed(3), endS: +(5 - leadPadS(0.5)).toFixed(3) },
    { startS: +(6 + tailPadS(0.5)).toFixed(3), endS: 8 },
  ]);
  // at Tight the breath goes too
  expect(
    cutPauses(
      [
        [1, 2],
        [2.3, 3],
      ],
      3,
      1,
    ).some((c) => c.startS > 2 && c.endS < 2.3),
  ).toBe(true);
});

test("no speech gives no cuts", () => {
  expect(cutPauses([], 60, 0.5)).toEqual([]);
  expect(planPauseCuts([], 60, { strictness: 0.5 })).toEqual({
    cuts: [],
    removedS: 0,
    keptS: 60,
    longKept: [],
    emptied: false,
  });
});

test("a long silent part is cut by default, and kept whole only when keepLongS asks for it", () => {
  const speech: [number, number][] = [
    [0, 5],
    [35, 40],
  ];
  const all = planPauseCuts(speech, 40, { strictness: 0.5 });
  expect(all.cuts).toHaveLength(1);
  expect(all.cuts[0]?.startS).toBeCloseTo(5 + tailPadS(0.5));
  expect(all.longKept).toEqual([]);
  expect(planPauseCuts(speech, 40, { strictness: 0.5, keepLongS: null }).cuts).toEqual(all.cuts);
  const keep = planPauseCuts(speech, 40, { strictness: 0.5, keepLongS: 10 });
  expect(keep.cuts).toEqual([]);
  expect(keep.longKept).toEqual(all.cuts);
  expect(keep.removedS).toBe(0);
  expect(keep.keptS).toBe(40);
});

test("removed and kept add up to the whole", () => {
  const plan = planPauseCuts(
    [
      [1, 2],
      [2.3, 3],
      [5, 6],
    ],
    8,
    { strictness: 0.5 },
  );
  expect(plan.cuts).toHaveLength(3);
  expect(plan.removedS + plan.keptS).toBeCloseTo(8, 6);
  expect(plan.removedS).toBeCloseTo(
    plan.cuts.reduce((s, c) => s + c.endS - c.startS, 0),
    6,
  );
  expect(plan.emptied).toBe(false);
});

test("a cut that would leave almost nothing is not made", () => {
  // half a second of "speech" in a minute: a breath or a click, not a talk
  const plan = planPauseCuts([[30, 30.5]], 60, { strictness: 0.5 });
  expect(plan.emptied).toBe(true);
  expect(plan.cuts).toEqual([]);
  expect(plan.removedS).toBe(0);
  expect(plan.keptS).toBe(60);
});

test("a range cut from a longer timeline keeps the lead and tail pads at its edges too", () => {
  const speech: [number, number][] = [
    [2, 3],
    [6, 7],
  ];
  // a whole recording: its edges need no pad
  expect(cutPauses(speech, 10, 0.5)[0]!.startS).toBe(0);
  expect(cutPauses(speech, 10, 0.5).at(-1)!.endS).toBe(10);
  // a range: a word straddling the edge keeps its pad
  const cuts = cutPauses(speech, 10, 0.5, { rangeEdges: true });
  expect(cuts[0]).toEqual({
    startS: +tailPadS(0.5).toFixed(3),
    endS: +(2 - leadPadS(0.5)).toFixed(3),
  });
  expect(cuts.at(-1)).toEqual({
    startS: +(7 + tailPadS(0.5)).toFixed(3),
    endS: +(10 - leadPadS(0.5)).toFixed(3),
  });
  expect(planPauseCuts(speech, 10, { strictness: 0.5, rangeEdges: true }).cuts).toEqual(cuts);
});
