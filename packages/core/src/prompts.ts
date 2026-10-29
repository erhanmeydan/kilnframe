import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const promptsDir = fileURLToPath(new URL("../prompts", import.meta.url));

/** A text file with Windows line ends (a checkout there, an editor) read as one with \n only. */
function readText(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

export function loadPrompt(name: string): string {
  return readText(join(promptsDir, `${name}.md`));
}

/** Technique modules exist only for proven techniques; others fall back to the base prompt. */
export function techniqueModule(technique: string): string | null {
  const path = join(promptsDir, "techniques", `${technique}.md`);
  return existsSync(path) ? readText(path) : null;
}

/** Pulls the first JSON object out of a model reply (tolerates code fences and stray prose). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? (fenced[1] as string) : text;
  const end = body.lastIndexOf("}");
  // prose before the object may have braces of its own ("for {scene s1}: {...}"): try each opening brace
  for (
    let start = body.indexOf("{");
    start >= 0 && start < end;
    start = body.indexOf("{", start + 1)
  ) {
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch {
      // not the object's own brace; try the next one
    }
  }
  throw new Error("The reply contains no JSON object.");
}

/**
 * Pulls the scene document out of the reply: the ```html fence that holds the <template> (or the whole reply
 * if it is bare HTML). Smaller local models sometimes show a snippet in a fence first, or leave out the
 * <template> around a complete scene; a scene root with its composition id is then wrapped in one.
 */
export function extractHtml(text: string): string {
  const fences = [...text.matchAll(/```html\s*([\s\S]*?)```/gi)].map((m) =>
    (m[1] as string).trim(),
  );
  const candidates = fences.length ? fences : [text.trim()];
  const html = candidates.find((c) => /<template[\s>]/i.test(c));
  if (html) return `${html}\n`;
  const bare = candidates.find((c) => /data-composition-id=/i.test(c));
  if (bare) return wrapInTemplate(bare);
  throw new Error("The reply contains no scene HTML with a <template>.");
}

/** A scene written without its <template>: its head's styles and scripts and its body go into one. */
function wrapInTemplate(html: string): string {
  const head = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(html);
  const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  const inner =
    head || body
      ? `${(head?.[1] ?? "").replace(/<title>[\s\S]*?<\/title>|<meta[^>]*>/gi, "")}\n${body?.[1] ?? ""}`
      : html.replace(/<!doctype[^>]*>|<\/?html[^>]*>/gi, "");
  return `<!doctype html>\n<html>\n  <body>\n    <template>\n${inner.trim()}\n    </template>\n  </body>\n</html>\n`;
}
