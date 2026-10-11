// kilnframe.com/changelog: every published release from GitHub, newest first, with its notes and installers.
// A release's notes are English; a "Türkçe" heading starts the Turkish part, which the Turkish page shows
// (English when a release has none). GitHub renders the Markdown (body_html), so nothing is parsed here.
(() => {
  const repo = "erhanmeydan/kilnframe";
  const tr = document.documentElement.lang === "tr";
  const box = document.querySelector("[data-releases]");
  if (!box) return;
  const text = tr
    ? {
        latest: "Son sürüm",
        mac: "Mac için indir",
        win: "Windows için indir",
        onlyEn: "Bu sürümün notları sadece İngilizce.",
        failed: "Sürümler şu an yüklenemedi.",
        all: "Bütün sürümlere GitHub'dan bakın",
      }
    : {
        latest: "Latest",
        mac: "Download for Mac",
        win: "Download for Windows",
        onlyEn: "",
        failed: "The releases could not be loaded right now.",
        all: "See all versions on GitHub",
      };

  // the part of the notes for this page's language
  function notes(html) {
    const doc = document.createElement("div");
    doc.innerHTML = html || "";
    const nodes = [...doc.children];
    const split = nodes.findIndex(
      (n) => /^H[1-4]$/.test(n.tagName) && n.textContent.trim().toLowerCase() === "türkçe",
    );
    const part = document.createElement("div");
    part.className = "notes";
    if (split < 0) {
      for (const n of nodes) part.append(n);
      if (tr && text.onlyEn)
        part.insertAdjacentHTML("afterbegin", `<p class="muted">${text.onlyEn}</p>`);
      return part;
    }
    for (const n of tr ? nodes.slice(split + 1) : nodes.slice(0, split)) part.append(n);
    return part;
  }

  function release(r, latest) {
    const el = document.createElement("article");
    el.className = "release";
    const date = new Date(r.published_at).toLocaleDateString(tr ? "tr-TR" : "en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    const asset = (name) => r.assets.find((a) => a.name === name)?.browser_download_url;
    const meta = document.createElement("div");
    meta.className = "rel-meta";
    meta.innerHTML = `<a class="rel-v" href="${r.html_url}">${r.tag_name.replace(/^v/, "")}</a><span class="tc">${date}</span>${
      latest ? `<span class="rel-badge">${text.latest}</span>` : ""
    }`;
    const body = document.createElement("div");
    body.className = "rel-body";
    body.append(notes(r.body_html));
    const dl = document.createElement("div");
    dl.className = "downloads";
    for (const [name, label, cls] of [
      ["Kilnframe-mac.pkg", text.mac, latest ? "btn solid" : "btn"],
      ["Kilnframe-Windows.exe", text.win, "btn"],
    ]) {
      const url = asset(name);
      if (url) dl.insertAdjacentHTML("beforeend", `<a class="${cls}" href="${url}">${label}</a>`);
    }
    body.append(dl);
    el.append(meta, body);
    return el;
  }

  fetch(`https://api.github.com/repos/${repo}/releases?per_page=50`, {
    headers: { Accept: "application/vnd.github.html+json" },
  })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((list) => {
      const shown = list.filter((r) => !r.draft && !r.prerelease);
      if (!shown.length) throw new Error("no releases");
      box.replaceChildren(...shown.map((r, i) => release(r, i === 0)));
    })
    .catch(() => {
      box.innerHTML = `<p class="muted">${text.failed} <a href="https://github.com/${repo}/releases">${text.all}</a>.</p>`;
    });
})();
