import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const promptsDir = fileURLToPath(new URL("../prompts", import.meta.url));

export function loadPrompt(name: string): string {
  return readFileSync(join(promptsDir, `${name}.md`), "utf8");
}

/** Technique modules exist only for proven techniques; others fall back to the base prompt. */
export function techniqueModule(technique: string): string | null {
  const path = join(promptsDir, "techniques", `${technique}.md`);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** Pulls the first JSON object out of a model reply (tolerates code fences and stray prose). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? (fenced[1] as string) : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The reply contains no JSON object.");
  return JSON.parse(body.slice(start, end + 1));
}

/** Pulls the HTML document out of a ```html fence (or the whole reply if it is bare HTML). */
export function extractHtml(text: string): string {
  const fenced = /```html\s*([\s\S]*?)```/i.exec(text);
  const html = (fenced ? (fenced[1] as string) : text).trim();
  if (!/<template[\s>]/i.test(html))
    throw new Error("The reply contains no scene HTML with a <template>.");
  return `${html}\n`;
}
