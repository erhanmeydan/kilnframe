import type { CaptionLine } from "./types.js";

function stamp(seconds: number): string {
  const total = Math.max(0, Math.round(seconds * 1000));
  const ms = total % 1000;
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60000) % 60;
  const h = Math.floor(total / 3600000);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(h)}:${two(m)}:${two(s)},${String(ms).padStart(3, "0")}`;
}

/** SubRip cues of the lines; `offsetS` is where the lines' zero lies in the sequence (an In/Out range's start). */
export function toSrt(lines: CaptionLine[], offsetS = 0): string {
  return lines
    .map(
      (line, i) =>
        `${i + 1}\n${stamp(offsetS + line.start)} --> ${stamp(offsetS + line.end)}\n${line.text}`,
    )
    .join("\n\n");
}
