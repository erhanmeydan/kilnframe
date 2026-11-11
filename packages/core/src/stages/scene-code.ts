/**
 * The parts of a scene's HTML that run or load something, apart from the text it shows. The static scene
 * rules look only at these: a code or ui-mockup scene that shows `fetch("https://…")`, `setTimeout(` or
 * `new Date(` on screen was rejected three times and failed the whole job (Nov 2026).
 */

export interface SceneCode {
  /** Script bodies with string contents and comments blanked out. */
  code: string;
  /** The same, but short word-like strings ("visible", "s1-grain") kept, for rules that read values. */
  codeWithWords: string;
  /** Markup tags with their attributes, without text: the page's and those a script writes (innerHTML). */
  tags: string;
  /** CSS: style element bodies and style attributes. */
  css: string;
  /** Script strings that a loader is handed, or that hold markup or CSS pointing somewhere. */
  loadedUrls: string[];
}

const NETWORK = /^\s*https?:\/\/(?!www\.w3\.org)/i;
/** Code right before a string that loads it: fetch(, import(, from, loader.load(, .src =, new Worker(. */
const LOADS =
  /(?:\bfetch|\bimport|\.load|\.loadAsync|\bimportScripts|\bnew\s+(?:Audio|Worker|WebSocket|EventSource|SharedWorker))\s*\(\s*$|\b(?:from|import)\s*$|\.(?:src|href)\s*=\s*$|\bopen\s*\(\s*(["'])\s*\1\s*,\s*$/;
/** Markup or CSS inside a string that would load from the network once inserted. */
const INNER_LOAD =
  /(?:\b(?:src|href|poster)\s*=\s*["']?|url\(\s*["']?|@import\s+["']?)https?:\/\/(?!www\.w3\.org)/i;
/** A string short and plain enough to be a value or a name rather than shown text. */
const WORD = /^[\w-]{1,40}$/;
const TAG = /<[a-z!/][^>]*>/gi;
/** In a template piece a tag may run on past a ${…}: `<feTurbulence seed="${seed}"/>`. */
const PIECE_TAG = /<[a-z!/][^>]*(?:>|$)/gi;

export function sceneCode(html: string): SceneCode {
  const scripts: string[] = [];
  const styles: string[] = [];
  const rest = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (m, body: string) => {
      scripts.push(body);
      return m.replace(body, "");
    })
    .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (m, body: string) => {
      styles.push(body);
      return m.replace(body, "");
    });
  const pageTags = (rest.match(TAG) ?? []).join("\n");
  for (const m of pageTags.matchAll(/\sstyle\s*=\s*("([^"]*)"|'([^']*)')/gi))
    styles.push(m[2] ?? m[3] ?? "");
  const scanned = scripts.map(scanJs);
  return {
    code: scanned.map((s) => s.code).join("\n"),
    codeWithWords: scanned.map((s) => s.withWords).join("\n"),
    tags: [pageTags, ...scanned.flatMap((s) => s.tags)].join("\n"),
    css: styles.join("\n"),
    loadedUrls: scanned.flatMap((s) => s.loaded),
  };
}

/** True when the scene loads anything over http(s): in an attribute, in CSS, or from a script. */
export function loadsFromNetwork(c: SceneCode): boolean {
  if (
    /\s(?:src|href|xlink:href|poster|data|srcset)\s*=\s*["']?\s*https?:\/\/(?!www\.w3\.org)/i.test(
      c.tags,
    )
  )
    return true;
  if (/(?:url\(|@import)\s*["']?\s*https?:\/\/(?!www\.w3\.org)/i.test(c.css)) return true;
  return c.loadedUrls.length > 0;
}

interface JsScan {
  code: string;
  withWords: string;
  loaded: string[];
  /** Tags inside strings, for markup a script inserts. */
  tags: string[];
}

/** Code characters after which a slash starts a regular expression rather than a division. */
const BEFORE_REGEX = /[(,=:[!&|?{};+\-*%<>~^]$|(?:^|[^\w$])(?:return|typeof|case|in|of)$|^$/;

/** Blanks string contents, template text and comments out of a script, keeping every position. */
function scanJs(src: string): JsScan {
  let code = "";
  let words = "";
  const loaded: string[] = [];
  const tags: string[] = [];
  // brace depth inside each open template ${…}, innermost last
  const frames: number[] = [];
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  const emit = (c: string, w = c) => {
    code += c;
    words += w;
  };
  const literal = (open: string, text: string, close: string) => {
    if ((NETWORK.test(text) && LOADS.test(code)) || INNER_LOAD.test(text)) loaded.push(text);
    tags.push(...(text.match(PIECE_TAG) ?? []));
    emit(open + blank(text) + close, open + (WORD.test(text) ? text : blank(text)) + close);
  };
  /** Reads template text from i to its closing backtick or to a `${`; returns where code resumes. */
  const template = (i: number, open: string): number => {
    let j = i;
    while (j < src.length && src[j] !== "`" && !(src[j] === "$" && src[j + 1] === "{"))
      j += src[j] === "\\" ? 2 : 1;
    const text = src.slice(i, j);
    if (j >= src.length) {
      literal(open, text, "");
      return j;
    }
    if (src[j] === "`") {
      literal(open, text, "`");
      return j + 1;
    }
    literal(open, text, "${");
    frames.push(0);
    return j + 2;
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      const end = src.indexOf("\n", i);
      const stop = end < 0 ? src.length : end;
      emit(blank(src.slice(i, stop)));
      i = stop;
    } else if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      emit(blank(src.slice(i, stop)));
      i = stop;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      literal(c, src.slice(i + 1, j), src[j] === c ? c : "");
      i = src[j] === c ? j + 1 : j;
    } else if (c === "`") {
      i = template(i + 1, "`");
    } else if (c === "}" && frames.length && frames[frames.length - 1] === 0) {
      frames.pop();
      i = template(i + 1, "}");
    } else if (c === "/" && BEFORE_REGEX.test(code.trimEnd())) {
      // a regular expression: skip to its closing slash (outside a character class) and flags
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== "\n" && (inClass || src[j] !== "/")) {
        if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        j += src[j] === "\\" ? 2 : 1;
      }
      emit("/" + blank(src.slice(i + 1, j)) + (src[j] === "/" ? "/" : ""));
      i = src[j] === "/" ? j + 1 : j;
    } else {
      const top = frames.length - 1;
      if (top >= 0 && c === "{") frames[top] = (frames[top] as number) + 1;
      else if (top >= 0 && c === "}") frames[top] = (frames[top] as number) - 1;
      emit(c);
      i++;
    }
  }
  return { code, withWords: words, loaded, tags };
}
