// Writes the docs search index, one file per language (assets/search-en.json, assets/search-tr.json), from the
// built pages: each docs page's title, then each of its h2/h3 headings with the text under it, and the Features
// page's sections. Run after build-docs.mjs, before publishing: node site/tools/build-search.mjs
// A row: { u: "docs/panels/cut/#step-2", t: page title, s: heading (empty for the page's top), c: section, x: text }
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_TEXT = 700;

const entities = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " ", rarr: "→", larr: "←", middot: "·" };
const text = (html) =>
  html
    .replace(/<template[\s\S]*?<\/template>/g, " ")
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#?\w+);/g, (m, e) => entities[e] ?? m)
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?)…’”])/g, "$1")
    .replace(/([(“‘])\s+/g, "$1")
    .trim();

function pages(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...pages(p));
    else if (name === "index.html") out.push(p);
  }
  return out;
}

// the page's body split at its headings: [{ id, heading, html }]
function chunks(body, levels) {
  const re = new RegExp(`<h(${levels})[^>]*\\bid="([^"]+)"[^>]*>([\\s\\S]*?)<\\/h\\1>`, "g");
  const out = [];
  let last = { id: "", heading: "", start: 0 };
  for (const m of body.matchAll(re)) {
    out.push({ ...last, html: body.slice(last.start, m.index) });
    last = { id: m[2], heading: text(m[3]), start: m.index + m[0].length };
  }
  out.push({ ...last, html: body.slice(last.start) });
  return out;
}

for (const lang of ["en", "tr"]) {
  const rows = [];
  const docsDir = join(SITE, lang === "en" ? "docs" : "tr/docs");
  for (const file of pages(docsDir).sort()) {
    const html = readFileSync(file, "utf8");
    const url = relative(SITE, file).replace(/index\.html$/, "");
    const article = /<article class="docs-body">([\s\S]*?)<nav class="pager"/.exec(html);
    if (!article) continue; // the docs home: its search and its list of pages
    const title = text(/<h1>([\s\S]*?)<\/h1>/.exec(article[1])[1]);
    const section = text(/<span class="tc crumb">([\s\S]*?)<\/span>/.exec(article[1])?.[1] ?? "");
    const body = article[1].replace(/^[\s\S]*?<\/h1>/, "");
    for (const c of chunks(body, "2|3")) {
      const x = text(c.html).slice(0, MAX_TEXT);
      if (!x && c.id) continue;
      rows.push({ u: url + (c.id ? `#${c.id}` : ""), t: title, s: c.heading, c: section, x });
    }
  }
  // the Features page, section by section
  const features = lang === "en" ? "features/index.html" : "tr/ozellikler/index.html";
  const fhtml = readFileSync(join(SITE, features), "utf8");
  const ftitle = text(/<h1>([\s\S]*?)<\/h1>/.exec(fhtml)[1]);
  const fname = lang === "en" ? "Features" : "Özellikler";
  for (const m0 of fhtml.matchAll(/<section class="feat" id="([^"]+)">([\s\S]*?)<\/section>/g)) {
    // the last cell of each row is its docs link ("Docs →", "Soon"): not words to search
    const m = [m0[0], m0[1], m0[2].replace(/<td>\s*<(a|span)\b[^>]*>[^<]*<\/\1>\s*<\/td>/g, "")];
    const heading = text(/<h2>([\s\S]*?)<\/h2>/.exec(m[2])[1]);
    rows.push({ u: features.replace(/index\.html$/, "") + `#${m[1]}`, t: fname, s: heading, c: ftitle, x: text(m[2].replace(/<h2>[\s\S]*?<\/h2>/, "")).slice(0, MAX_TEXT) });
  }
  const out = join(SITE, "assets", `search-${lang}.json`);
  writeFileSync(out, JSON.stringify(rows));
  console.log(`${relative(SITE, out)}: ${rows.length} rows, ${(statSync(out).size / 1024).toFixed(1)} KB`);
}
