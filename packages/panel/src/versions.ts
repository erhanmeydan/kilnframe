/** True when version `a` (0.4.1) comes before `b` (0.4.2); unreadable parts count as 0. */
export function olderVersion(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0;
  }
  return false;
}

/** The side that is older when the panel and the app differ; null when they match or the app is unknown. */
export function versionGap(panel: string, app: string | null): "panel" | "app" | null {
  if (!app) return null;
  if (olderVersion(panel, app)) return "panel";
  return olderVersion(app, panel) ? "app" : null;
}
