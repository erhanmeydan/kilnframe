export type Shape = "landscape" | "portrait" | "square";

function shapeOf(size: string): Shape | null {
  const m = /^(\d+)x(\d+)$/.exec(size);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w === h ? "square" : w > h ? "landscape" : "portrait";
}

/**
 * The chosen format and the sequence's shape when they differ. The insert is still made as chosen; the
 * editor hears it first, because a portrait insert on a landscape timeline lands small in the middle.
 */
export function formatMismatch(
  sequenceSize: string,
  format: string,
): { sequence: Shape; chosen: Shape } | null {
  if (format !== "landscape" && format !== "portrait" && format !== "square") return null;
  const sequence = shapeOf(sequenceSize);
  if (!sequence || sequence === format) return null;
  return { sequence, chosen: format };
}
