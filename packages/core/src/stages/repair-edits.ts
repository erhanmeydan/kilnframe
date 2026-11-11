/**
 * Repairs as edits: the model answers a repair with search/replace blocks instead of the whole scene, which
 * is a fraction of the output (a scene is 4–6k tokens of HTML, a fix is usually a few lines). A reply that
 * holds a whole file is still taken as before.
 */

export interface SceneEdit {
  search: string;
  replace: string;
}

const EDIT_BLOCK = /<{5,9} ?SEARCH[^\n]*\n([\s\S]*?)\n?={5,9}[^\n]*\n([\s\S]*?)\n?>{5,9} ?REPLACE/g;

/** The search/replace blocks of a reply, in order; none when it holds none. */
export function parseEdits(reply: string): SceneEdit[] {
  return [...reply.matchAll(EDIT_BLOCK)].map((m) => ({
    search: m[1] as string,
    replace: m[2] as string,
  }));
}

/** Where `needle` occurs in `haystack`: every start index. */
function occurrences(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + 1)) out.push(i);
  return out;
}

/**
 * The line range of `html` whose lines equal the search's lines once leading and trailing spaces are
 * dropped (models often get the indentation of a copied line wrong), when exactly one such range exists.
 */
function looseLineMatch(html: string, search: string): { start: number; end: number } | null {
  const want = search
    .split("\n")
    .map((l) => l.trim())
    .filter((l, i, all) => l || (i > 0 && i < all.length - 1));
  if (!want.length || !want.some((l) => l)) return null;
  const lines = html.split("\n");
  const starts: number[] = [];
  let at = 0;
  for (const l of lines) {
    starts.push(at);
    at += l.length + 1;
  }
  const found: { start: number; end: number }[] = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    if (want.every((w, k) => (lines[i + k] as string).trim() === w)) {
      const last = i + want.length - 1;
      found.push({
        start: starts[i] as number,
        end: (starts[last] as number) + (lines[last] as string).length,
      });
    }
  }
  return found.length === 1 ? (found[0] as { start: number; end: number }) : null;
}

export type ApplyResult = { ok: true; html: string } | { ok: false; problems: string[] };

/**
 * Applies the edits in order. Each search must be found exactly once (exactly, or line by line ignoring
 * indentation); otherwise nothing is applied and the failed searches are named.
 */
export function applyEdits(html: string, edits: SceneEdit[]): ApplyResult {
  let out = html.replace(/\r\n/g, "\n");
  const problems: string[] = [];
  edits.forEach((e, i) => {
    const search = e.search.replace(/\r\n/g, "\n");
    const replace = e.replace.replace(/\r\n/g, "\n");
    const exact = occurrences(out, search);
    if (exact.length === 1) {
      const at = exact[0] as number;
      out = out.slice(0, at) + replace + out.slice(at + search.length);
      return;
    }
    const loose = exact.length === 0 ? looseLineMatch(out, search) : null;
    if (loose) {
      out = out.slice(0, loose.start) + replace + out.slice(loose.end);
      return;
    }
    const first = search.trim().split("\n")[0]?.trim().slice(0, 80) ?? "";
    problems.push(
      exact.length > 1
        ? `edit ${i + 1} (starting "${first}") matches ${exact.length} places; it must match one`
        : `edit ${i + 1} (starting "${first}") was not found in the current file`,
    );
  });
  return problems.length ? { ok: false, problems } : { ok: true, html: out };
}
