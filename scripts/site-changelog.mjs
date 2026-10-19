// Writes the GitHub releases into the changelog pages as plain HTML, so search engines and AI assistants read
// them without running a script: node scripts/site-changelog.mjs <siteDir>. The Pages workflow runs it on its
// copy of site/ before publishing; site/assets/changelog.js still refreshes the list in the browser.
// The markup is the one changelog.js builds. GITHUB_TOKEN, when set, avoids the API's anonymous rate limit.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repo = "erhanmeydan/kilnframe";
const site = process.argv[2] ?? "site";

const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=50`, {
  headers: {
    Accept: "application/vnd.github.html+json",
    ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
  },
});
if (!res.ok) throw new Error(`GitHub releases: ${res.status}`);
const releases = (await res.json()).filter((r) => !r.draft && !r.prerelease);

const pages = [
  {
    file: join(site, "changelog", "index.html"),
    tr: false,
    text: { latest: "Latest", mac: "Download for Mac", win: "Download for Windows", onlyEn: "" },
  },
  {
    file: join(site, "tr", "changelog", "index.html"),
    tr: true,
    text: {
      latest: "Son sürüm",
      mac: "Mac için indir",
      win: "Windows için indir",
      onlyEn: "Bu sürümün notları sadece İngilizce.",
    },
  },
];

const turkish = /<h[1-4][^>]*>\s*Türkçe\s*<\/h[1-4]>/i;

/** The part of a release's notes for one language: before or after its "Türkçe" heading. */
function notes(html, page) {
  const body = html ?? "";
  const at = body.search(turkish);
  if (at < 0) return (page.tr ? `<p class="muted">${page.text.onlyEn}</p>` : "") + body;
  return page.tr ? body.slice(at).replace(turkish, "") : body.slice(0, at);
}

function article(r, latest, page) {
  const date = new Date(r.published_at).toLocaleDateString(page.tr ? "tr-TR" : "en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Istanbul",
  });
  const asset = (name) => r.assets.find((a) => a.name === name)?.browser_download_url;
  const links = [
    ["Kilnframe-mac.pkg", page.text.mac, latest ? "btn solid" : "btn", "download-mac"],
    ["Kilnframe-Windows.exe", page.text.win, "btn", "download-windows"],
  ]
    .filter(([name]) => asset(name))
    .map(
      ([name, label, cls, click]) =>
        `<a class="${cls}" data-goatcounter-click="${click}" href="${asset(name)}">${label}</a>`,
    )
    .join("");
  return `<article class="release"><div class="rel-meta"><a class="rel-v" href="${r.html_url}">${r.tag_name.replace(/^v/, "")}</a><span class="tc">${date}</span>${
    latest ? `<span class="rel-badge">${page.text.latest}</span>` : ""
  }</div><div class="rel-body"><div class="notes">${notes(r.body_html, page)}</div><div class="downloads">${links}</div></div></article>`;
}

for (const page of pages) {
  const html = readFileSync(page.file, "utf8");
  const open = html.indexOf('<div class="releases" data-releases>');
  if (open < 0) throw new Error(`no releases box in ${page.file}`);
  const start = open + '<div class="releases" data-releases>'.length;
  const end = html.indexOf("</div>", start);
  const list = releases.map((r, i) => article(r, i === 0, page)).join("\n");
  writeFileSync(page.file, `${html.slice(0, start)}\n${list}\n${html.slice(end)}`);
  console.log(`${page.file}: ${releases.length} releases`);
}
