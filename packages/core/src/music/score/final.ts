// packages/core/src/music/score/final.ts
// The finale: the strongest attack in the last quarter of the closing piece is its hit. The hit lands when
// the speech ends (or 2 s before the range's end), and its decay reaches silence on the last frame.
import { SR } from "./audio-io.js";
import { energy, fade } from "./fit.js";

const ATTACK_RATIO = 6; // a hit jumps at least this much over the 200 ms before it

export function findHit(ch: Float32Array[], fromS?: number): number | null {
  const e = energy(ch);
  const from = Math.floor(((fromS ?? (ch[0]!.length / SR) * 0.75) * SR) / Math.round(0.01 * SR));
  let best: number | null = null;
  let bestJump = ATTACK_RATIO;
  for (let i = Math.max(20, from); i < e.length; i++) {
    let before = 0;
    for (let k = i - 20; k < i; k++) before += e[k]!;
    before = before / 20 + 1e-9;
    const jump = e[i]! / before;
    if (jump > bestJump) {
      bestJump = jump;
      best = i;
    }
  }
  return best === null ? null : +(best * 0.01).toFixed(2);
}

export function alignFinal(o: {
  music: Float32Array[];
  hitS: number;
  sectionStartS: number;
  rangeDurationS: number;
  lastWordEndS: number | null;
}): Float32Array[] {
  const sectionLen = o.rangeDurationS - o.sectionStartS;
  const endWord = o.lastWordEndS ?? -Infinity;
  const hitAtRange = endWord >= o.rangeDurationS - 3 ? endWord : o.rangeDurationS - 2;
  const hitAt = hitAtRange - o.sectionStartS; // seconds into the section
  const shift = Math.round((hitAt - o.hitS) * SR); // > 0: the music starts later than the section
  const total = Math.round(sectionLen * SR);
  const out = o.music.map((c) => {
    const x = new Float32Array(total);
    for (let i = 0; i < total; i++) {
      const src = i - shift;
      x[i] = src >= 0 && src < c.length ? c[src]! : 0;
    }
    return x;
  });
  const tail = Math.min(0.5, Math.max(0.05, sectionLen - hitAt));
  return fade(out, 0, tail);
}
