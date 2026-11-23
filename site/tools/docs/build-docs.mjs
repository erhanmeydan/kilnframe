// Builds the Features page and the Docs pages of kilnframe.com from the fragments in pages/<lang>/ and the tree in
// tree.mjs: the site's header and footer, the sidebar with the whole tree (pages not written yet greyed, not
// linked), "on this page", previous and next, the EN/TR switch, and the sitemap entries. Plain Node, no packages:
//   node site/tools/docs/build-docs.mjs && node site/tools/build-search.mjs
//
// A fragment is the page's body without its h1 (the title comes from the tree). It starts with a comment
// <!-- description: ... --> for the meta description. Inside it:
//   {{img}}            the folder of this language's screenshots (assets/docs/<lang>/)
//   {{root}}           the site's root, relative to the page
//   <a data-doc="D12#anchor">words</a>   a link to another docs page in the same language; a page not written yet
//                      becomes plain text (an empty link becomes "Docs →" or "Soon")
//   <a data-page="features|docs|home|privacy|plugin">  the other pages of the site in the same language
// <img> tags without a width get the picture's own width and height.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SECTIONS } from "./tree.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, "..", "..");
const ORIGIN = "https://kilnframe.com/";

const WORDS = {
  en: {
    nav: ["Features", "Docs", "Price", "Plugin"],
    cta: ["Get notified", "#notify"],
    price: "#price",
    docsName: "Kilnframe Desktop Docs",
    docsShort: "Docs",
    titleTail: "Kilnframe Desktop Docs",
    contents: "Contents",
    search: "Search the docs",
    searchLabel: "Search the docs",
    empty: 'No results. Try other words, or the <a data-doc="D52">FAQ</a>.',
    onPage: "On this page",
    prev: "Previous",
    next: "Next",
    soon: "Soon",
    soonTitle: "Coming soon",
    docLink: "Docs →",
    footer: ["Free plugin", "Privacy", "Terms"],
    by: "Kilnframe Desktop by Erhan Meydan",
    sectionsLabel: "Docs sections",
    locale: "en_US",
  },
  tr: {
    nav: ["Özellikler", "Kılavuz", "Fiyat", "Eklenti"],
    cta: ["Haber ver", "#haber"],
    price: "#fiyat",
    docsName: "Kilnframe Desktop Kılavuzu",
    docsShort: "Kılavuz",
    titleTail: "Kilnframe Desktop Kılavuzu",
    contents: "İçindekiler",
    search: "Kılavuzda ara",
    searchLabel: "Kılavuzda ara",
    empty: 'Sonuç yok. Başka kelimeler dene ya da <a data-doc="D52">sık sorulanlara</a> bak.',
    onPage: "Bu sayfada",
    prev: "Önceki",
    next: "Sonraki",
    soon: "Yakında",
    soonTitle: "Yakında",
    docLink: "Kılavuz →",
    footer: ["Ücretsiz eklenti", "Gizlilik", "Koşullar"],
    by: "Kilnframe Desktop, Erhan Meydan",
    sectionsLabel: "Kılavuz bölümleri",
    locale: "tr_TR",
  },
};

// the site paths of each page, root-relative and ending in "/"
const SPECIAL = {
  home: { en: "", tr: "tr/" },
  features: { en: "features/", tr: "tr/ozellikler/" },
  docs: { en: "docs/", tr: "tr/docs/" },
  privacy: { en: "desktop/privacy/", tr: "tr/desktop/privacy/" },
  terms: { en: "desktop/terms/", tr: "tr/desktop/terms/" },
  plugin: { en: "plugin/", tr: "tr/plugin/" },
};

const PAGES = []; // in tree order: { id, section: {en,tr}, en: {path,title}, tr: {path,title}, done }
for (const s of SECTIONS)
  for (const [id, enSlug, enTitle, trSlug, trTitle] of s.pages)
    PAGES.push({
      id,
      section: s,
      en: { path: `docs/${enSlug}/`, title: enTitle },
      tr: { path: `tr/docs/${trSlug}/`, title: trTitle },
      done: existsSync(join(HERE, "pages", "en", `${id}.html`)) && existsSync(join(HERE, "pages", "tr", `${id}.html`)),
    });
const BY_ID = new Map(PAGES.map((p) => [p.id, p]));

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const rel = (from, to) => "../".repeat(from.split("/").filter(Boolean).length) + to;

// Turkish letters folded, for ids that read the same in both languages' URLs
export function fold(s) {
  return s
    .toLocaleLowerCase("tr")
    .replace(/ı/g, "i")
    .replace(/ş/g, "s")
    .replace(/ğ/g, "g")
    .replace(/ç/g, "c")
    .replace(/ö/g, "o")
    .replace(/ü/g, "u")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}
const slugify = (s) =>
  fold(s.replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, " "))
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

// the size of a WebP or PNG picture
function imageSize(file) {
  const b = readFileSync(file);
  if (b.toString("ascii", 1, 4) === "PNG") return [b.readUInt32BE(16), b.readUInt32BE(20)];
  const kind = b.toString("ascii", 12, 16);
  if (kind === "VP8X") return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
  if (kind === "VP8L") {
    const n = b.readUInt32LE(21);
    return [1 + (n & 0x3fff), 1 + ((n >> 14) & 0x3fff)];
  }
  if (kind === "VP8 ") return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
  throw new Error(`unknown picture ${file}`);
}

function resolveBody(html, lang, here) {
  const w = WORDS[lang];
  html = html.replace(/\{\{img\}\}/g, rel(here, `assets/docs/${lang}/`)).replace(/\{\{root\}\}/g, rel(here, ""));
  // links to docs pages
  html = html.replace(/<a ([^>]*?)data-doc="(D\d\d|docs)(#[^"]*)?"([^>]*)>([\s\S]*?)<\/a>/g, (_, pre, id, hash = "", attrs, text) => {
    if (id === "docs" || id === "D01") return `<a ${pre}href="${rel(here, SPECIAL.docs[lang])}${hash}"${attrs}>${text || w.docsShort}</a>`;
    const p = BY_ID.get(id);
    if (!p) throw new Error(`no page ${id}`);
    if (!p.done) {
      const cls = /class="([^"]*)"/.exec(pre + attrs)?.[1];
      return `<span class="soon${cls ? ` ${cls}` : ""}" title="${w.soonTitle}">${text || w.soon}</span>`;
    }
    return `<a ${pre}href="${rel(here, p[lang].path)}${hash}"${attrs}>${text || w.docLink}</a>`;
  });
  html = html.replace(/<a ([^>]*?)data-page="(\w+)(#[^"]*)?"/g, (_, pre, name, hash = "") => {
    if (!SPECIAL[name]) throw new Error(`no page ${name}`);
    return `<a ${pre}href="${rel(here, SPECIAL[name][lang])}${hash}"`;
  });
  // picture sizes
  html = html.replace(/<img ([^>]*?)src="([^"]+)"([^>]*)>/g, (m, a, src, b) => {
    if (/\bwidth=/.test(a + b)) return m;
    const file = join(SITE, here, src);
    if (!existsSync(file)) throw new Error(`missing picture ${src} on ${here}`);
    const [wd, ht] = imageSize(file);
    return `<img ${a}src="${src}" width="${wd}" height="${ht}"${b}>`;
  });
  return html;
}

// h2s get ids from their words; the list of them is "on this page"
function headings(html) {
  const toc = [];
  const seen = new Set();
  html = html.replace(/<h2(\s[^>]*)?>([\s\S]*?)<\/h2>/g, (m, attrs = "", inner) => {
    let id = /\bid="([^"]+)"/.exec(attrs)?.[1];
    if (!id) {
      id = slugify(inner);
      while (seen.has(id)) id += "-2";
      attrs += ` id="${id}"`;
    }
    seen.add(id);
    toc.push([id, inner.replace(/<[^>]+>/g, "")]);
    return `<h2${attrs}>${inner}</h2>`;
  });
  html = html.replace(/<h3(\s[^>]*)?>([\s\S]*?)<\/h3>/g, (m, attrs = "", inner) => {
    if (/\bid="/.test(attrs)) return m;
    let id = slugify(inner);
    while (seen.has(id)) id += "-2";
    seen.add(id);
    return `<h3${attrs} id="${id}">${inner}</h3>`;
  });
  return { html, toc };
}

function readFragment(lang, name) {
  const raw = readFileSync(join(HERE, "pages", lang, `${name}.html`), "utf8");
  const m = /^\s*<!--\s*description:\s*([\s\S]*?)-->/.exec(raw);
  if (!m) throw new Error(`${lang}/${name}: no description comment`);
  return { description: m[1].trim().replace(/\s+/g, " "), body: raw.slice(m[0].length).trim() };
}

function head({ lang, here, title, description, enPath, trPath }) {
  const self = lang === "en" ? enPath : trPath;
  return `<!doctype html>
<html lang="${lang}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(description)}" />
    <link rel="icon" href="${rel(here, "assets/desktop/favicon.png")}" />
    <link rel="canonical" href="${ORIGIN}${self}" />
    <link rel="alternate" hreflang="en" href="${ORIGIN}${enPath}" />
    <link rel="alternate" hreflang="tr" href="${ORIGIN}${trPath}" />
    <link rel="alternate" hreflang="x-default" href="${ORIGIN}${enPath}" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="${ORIGIN}${self}" />
    <meta property="og:site_name" content="Kilnframe" />
    <meta property="og:title" content="${esc(title)}" />
    <meta property="og:description" content="${esc(description)}" />
    <meta property="og:locale" content="${WORDS[lang].locale}" />
    <meta property="og:image" content="${ORIGIN}assets/desktop/share.jpg" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:site" content="@kilnframe" />
    <link rel="stylesheet" href="${rel(here, "assets/studio.css")}" />
    <script>document.documentElement.classList.add("js")</script>
    <!-- visit counts without cookies (goatcounter.com) -->
    <script
      data-goatcounter="https://kilnframe.goatcounter.com/count"
      async
      src="//gc.zgo.at/count.js"
    ></script>
  </head>
  <body>`;
}

function header({ lang, here, current, enPath, trPath }) {
  const w = WORDS[lang];
  const links = [
    [w.nav[0], SPECIAL.features[lang], "features"],
    [w.nav[1], SPECIAL.docs[lang], "docs"],
    [w.nav[2], SPECIAL.home[lang] + w.price, "price"],
    [w.nav[3], SPECIAL.plugin[lang], "plugin"],
  ];
  const nav = links
    .map(([t, p, k]) => `<a href="${rel(here, p)}"${k === current ? ' aria-current="page"' : ""}>${t}</a>`)
    .join("\n          ");
  const en = lang === "en" ? `<a href="./" aria-current="page">EN</a>` : `<a href="${rel(here, enPath)}" hreflang="en">EN</a>`;
  const tr = lang === "tr" ? `<a href="./" aria-current="page">TR</a>` : `<a href="${rel(here, trPath)}" hreflang="tr">TR</a>`;
  return `
    <header class="top">
      <div class="wrap">
        <a class="brand" href="${rel(here, SPECIAL.home[lang])}"><img src="${rel(here, "assets/desktop/icon.png")}" alt="" />Kilnframe Desktop</a>
        <nav>
          ${nav}
        </nav>
        <div class="lang">${en}${tr}</div>
        <a class="btn solid" href="${rel(here, SPECIAL.home[lang])}${w.cta[1]}">${w.cta[0]}</a>
      </div>
    </header>`;
}

function footer({ lang, here, scripts }) {
  const w = WORDS[lang];
  return `
    <footer>
      <div class="wrap">
        <span>${w.by}</span>
        <span
          ><a href="${rel(here, SPECIAL.features[lang])}">${w.nav[0]}</a> · <a href="${rel(here, SPECIAL.docs[lang])}">${w.nav[1]}</a> ·
          <a href="${rel(here, SPECIAL.plugin[lang])}">${w.footer[0]}</a> · <a href="${rel(here, SPECIAL.privacy[lang])}">${w.footer[1]}</a> ·
          <a href="${rel(here, SPECIAL.terms[lang])}">${w.footer[2]}</a> ·
          <a href="mailto:hello@kilnframe.com">hello@kilnframe.com</a></span
        >
      </div>
    </footer>
${scripts.map((s) => `    <script src="${rel(here, s)}"></script>`).join("\n")}
  </body>
</html>
`;
}

function searchForm(lang, here, cls = "") {
  const w = WORDS[lang];
  return `<form class="search${cls}" action="${rel(here, SPECIAL.docs[lang])}" method="get" role="search">
          <input type="search" name="q" placeholder="${w.search}" aria-label="${w.searchLabel}" autocomplete="off" spellcheck="false" />
          <template class="search-empty">${resolveBody(w.empty, lang, here)}</template>
        </form>`;
}

function sidebar(lang, here, currentId) {
  const w = WORDS[lang];
  const groups = SECTIONS.map((s) => {
    const items = PAGES.filter((p) => p.section === s)
      .map((p) => {
        const t = esc(p[lang].title);
        if (!p.done) return `<li><span class="soon" title="${w.soonTitle}">${t}</span></li>`;
        const cur = p.id === currentId ? ' aria-current="page"' : "";
        return `<li><a href="${rel(here, p[lang].path)}"${cur}>${t}</a></li>`;
      })
      .join("\n            ");
    return `<p>${s[lang]}</p>
          <ul>
            ${items}
          </ul>`;
  }).join("\n          ");
  const home = `<ul><li><a href="${rel(here, SPECIAL.docs[lang])}"${currentId === "D01" ? ' aria-current="page"' : ""}>${w.docsName}</a></li></ul>`;
  return `<button class="docs-menu" type="button" aria-controls="docs-side" aria-expanded="false">${w.contents}</button>
      <aside class="docs-side" id="docs-side">
        ${searchForm(lang, here)}
        <nav aria-label="${w.docsShort}">
          ${home}
          ${groups}
        </nav>
      </aside>`;
}

const written = [];
function write(path, html) {
  const file = join(SITE, path, "index.html");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
  written.push(path);
}

// --- docs pages
const done = PAGES.filter((p) => p.done);
for (const lang of ["en", "tr"]) {
  const w = WORDS[lang];
  for (const [i, p] of done.entries()) {
    const here = p[lang].path;
    const { description, body } = readFragment(lang, p.id);
    const { html, toc } = headings(resolveBody(body, lang, here));
    const prev = i === 0 ? { [lang]: { path: SPECIAL.docs[lang], title: w.docsName } } : done[i - 1];
    const next = done[i + 1];
    const pager = `<nav class="pager" aria-label="${w.prev} / ${w.next}">
          <a class="prev" rel="prev" href="${rel(here, prev[lang].path)}"><small>← ${w.prev}</small><b>${esc(prev[lang].title)}</b></a>
          ${next ? `<a class="next" rel="next" href="${rel(here, next[lang].path)}"><small>${w.next} →</small><b>${esc(next[lang].title)}</b></a>` : ""}
        </nav>`;
    const long = toc.length >= 3;
    const tocHtml = long
      ? `
      <nav class="toc" aria-label="${w.onPage}">
        <p>${w.onPage}</p>
        <ul>
          ${toc.map(([id, t]) => `<li><a href="#${id}">${t}</a></li>`).join("\n          ")}
        </ul>
      </nav>`
      : "";
    const page =
      head({ lang, here, title: `${p[lang].title} · ${w.titleTail}`, description, enPath: p.en.path, trPath: p.tr.path }) +
      header({ lang, here, current: "docs", enPath: p.en.path, trPath: p.tr.path }) +
      `
    <main class="docs">
      <div class="wrap docs-grid${long ? "" : " no-toc"}">
      ${sidebar(lang, here, p.id)}
      <article class="docs-body">
        <span class="tc crumb">${p.section[lang].toLocaleUpperCase(lang)}</span>
        <h1>${esc(p[lang].title)}</h1>
        ${html}
        ${pager}
      </article>${tocHtml}
      </div>
    </main>
` +
      footer({ lang, here, scripts: ["assets/docs-search.js", "assets/docs.js"] });
    write(here, page);
  }

  // --- the docs home (D01): the search, the first video, the sections, the quick questions
  {
    const here = SPECIAL.docs[lang];
    const { description, body } = readFragment(lang, "D01");
    const parts = body.split("<!-- sections -->");
    const sections = SECTIONS.map((s) => {
      const items = PAGES.filter((p) => p.section === s)
        .map((p) => (p.done ? `<li><a href="${rel(here, p[lang].path)}">${esc(p[lang].title)}</a></li>` : `<li><span class="soon" title="${w.soonTitle}">${esc(p[lang].title)}</span></li>`))
        .join("\n              ");
      return `<div>
            <h2>${s[lang]}</h2>
            <ul>
              ${items}
            </ul>
          </div>`;
    }).join("\n          ");
    const page =
      head({ lang, here, title: w.docsName, description, enPath: SPECIAL.docs.en, trPath: SPECIAL.docs.tr }) +
      header({ lang, here, current: "docs", enPath: SPECIAL.docs.en, trPath: SPECIAL.docs.tr }) +
      `
    <main>
      <div class="page-head">
        <div class="wrap">
          <span class="tc">${w.docsShort.toLocaleUpperCase(lang)}</span>
          <h1>${w.docsName}</h1>
          ${searchForm(lang, here, " search-hero")}
        </div>
      </div>
      <div class="wrap docs-home">
        ${resolveBody(parts[0], lang, here)}
        <div class="sections" aria-label="${w.sectionsLabel}">
          ${sections}
        </div>
        ${resolveBody(parts[1] ?? "", lang, here)}
      </div>
    </main>
` +
      footer({ lang, here, scripts: ["assets/docs-search.js", "assets/docs.js"] });
    write(here, page);
  }

  // --- the Features page
  {
    const here = SPECIAL.features[lang];
    const { description, body } = readFragment(lang, "features");
    const html = resolveBody(body, lang, here);
    const index = [...html.matchAll(/<section class="feat" id="([^"]+)">\s*<h2>([\s\S]*?)<\/h2>/g)]
      .map(([, id, t]) => `<li><a href="#${id}">${t.replace(/<[^>]+>/g, "")}</a></li>`)
      .join("\n            ");
    const [intro, rest] = html.split("<!-- sections -->");
    const page =
      head({ lang, here, title: lang === "en" ? "Features · Kilnframe Desktop" : "Özellikler · Kilnframe Desktop", description, enPath: SPECIAL.features.en, trPath: SPECIAL.features.tr }) +
      header({ lang, here, current: "features", enPath: SPECIAL.features.en, trPath: SPECIAL.features.tr }) +
      `
    <main>
      ${intro}
      <div class="wrap feat-grid">
        <nav class="feat-index" aria-label="${w.nav[0]}">
          <ol>
            ${index}
          </ol>
        </nav>
        <div>
          ${rest}
        </div>
      </div>
    </main>
` +
      footer({ lang, here, scripts: ["assets/site.js"] });
    write(here, page);
  }
}

// --- sitemap: the generated block between its markers, each page with its pair
{
  const file = join(SITE, "sitemap.xml");
  let xml = readFileSync(file, "utf8");
  const pairs = [[SPECIAL.features.en, SPECIAL.features.tr], [SPECIAL.docs.en, SPECIAL.docs.tr], ...done.map((p) => [p.en.path, p.tr.path])];
  const entry = (loc, en, tr) => `  <url>
    <loc>${ORIGIN}${loc}</loc>
    <xhtml:link rel="alternate" hreflang="en" href="${ORIGIN}${en}" />
    <xhtml:link rel="alternate" hreflang="tr" href="${ORIGIN}${tr}" />
    <xhtml:link rel="alternate" hreflang="x-default" href="${ORIGIN}${en}" />
  </url>`;
  const block = `  <!-- features and docs: written by site/tools/docs/build-docs.mjs -->
${pairs.flatMap(([en, tr]) => [entry(en, en, tr), entry(tr, en, tr)]).join("\n")}
  <!-- end of features and docs -->`;
  const re = /  <!-- features and docs:[\s\S]*?<!-- end of features and docs -->/;
  xml = re.test(xml) ? xml.replace(re, block) : xml.replace("</urlset>", `${block}\n</urlset>`);
  writeFileSync(file, xml);
}

console.log(`${written.length} pages: ${written.join(" ")}`);
