// kilnframe.com docs search, without a library: the index of the page's language (search-en.json or
// search-tr.json, written by tools/build-search.mjs) loads once, the first time a search box is focused. Every
// word typed must appear; a match in a page's title weighs most, then in a heading, then in the text. Turkish
// letters fold to plain ones, so "gurultu" finds "gürültü". Arrow keys move through the results, Enter opens
// one, Esc closes the list and "/" jumps to the box. The words of the page (placeholder, "no results") are in
// its own HTML; without the script the box is a plain form to the docs home, which lists every page.
(() => {
  const script = document.currentScript;
  const lang = document.documentElement.lang === "tr" ? "tr" : "en";
  const root = new URL("../", script.src);
  const indexUrl = new URL(`search-${lang}.json`, script.src);
  let index = null;
  let loading = null;

  // one character in, one character out, so a match found in the folded text is at the same place in the original
  const MAP = { ı: "i", ş: "s", ğ: "g", ç: "c", ö: "o", ü: "u", â: "a", î: "i", û: "u" };
  const foldChar = (c) => {
    let l = c.toLocaleLowerCase(lang === "tr" ? "tr" : "en");
    if (l.length !== 1) l = c.toLowerCase().charAt(0);
    if (MAP[l]) return MAP[l];
    const d = l.normalize("NFD").charAt(0);
    return d.length === 1 ? d : l;
  };
  const fold = (s) => Array.from(s, foldChar).join("");

  const load = () =>
    (loading ??= fetch(indexUrl)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => {
        index = rows.map((r) => ({ ...r, ft: fold(r.t), fs: fold(r.s || ""), fx: fold(r.x) }));
      })
      .catch(() => {
        index = [];
      }));

  const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // the words marked in a piece of text, found in its folded copy
  const mark = (text, terms) => {
    const f = fold(text);
    const spans = [];
    for (const t of terms) {
      let at = f.indexOf(t);
      while (at !== -1) {
        spans.push([at, at + t.length]);
        at = f.indexOf(t, at + t.length);
      }
    }
    spans.sort((a, b) => a[0] - b[0]);
    let out = "";
    let pos = 0;
    for (const [a, b] of spans) {
      if (a < pos) continue;
      out += escapeHtml(text.slice(pos, a)) + "<mark>" + escapeHtml(text.slice(a, b)) + "</mark>";
      pos = b;
    }
    return out + escapeHtml(text.slice(pos));
  };
  // about 150 characters of the text around the first word found
  const snippet = (row, terms) => {
    let at = -1;
    for (const t of terms) {
      const i = row.fx.indexOf(t);
      if (i !== -1 && (at === -1 || i < at)) at = i;
    }
    if (at === -1) return mark(row.x.slice(0, 150) + (row.x.length > 150 ? "…" : ""), terms);
    let start = Math.max(0, at - 50);
    if (start > 0) start = row.x.indexOf(" ", start) + 1 || start;
    const end = Math.min(row.x.length, start + 150);
    return (start > 0 ? "…" : "") + mark(row.x.slice(start, end), terms) + (end < row.x.length ? "…" : "");
  };

  const search = (query) => {
    const terms = fold(query).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0);
    if (!terms.length || !index) return { terms, hits: [] };
    const hits = [];
    for (const row of index) {
      let score = 0;
      let all = true;
      for (const t of terms) {
        const inTitle = row.ft.includes(t);
        const inHead = row.fs.includes(t);
        const inText = row.fx.includes(t);
        if (!inTitle && !inHead && !inText) {
          all = false;
          break;
        }
        score += (inTitle ? 10 : 0) + (inHead ? 5 : 0) + (inText ? 1 : 0);
        if (row.ft.startsWith(t) || row.fs.startsWith(t)) score += 2;
      }
      if (all) hits.push({ row, score: score + (row.s ? 0 : 1) });
    }
    hits.sort((a, b) => b.score - a.score);
    // one page at most twice, so the list shows more than one page
    const per = new Map();
    const kept = [];
    for (const h of hits) {
      const page = h.row.u.split("#")[0];
      const n = per.get(page) ?? 0;
      if (n >= 2) continue;
      per.set(page, n + 1);
      kept.push(h);
      if (kept.length === 8) break;
    }
    return { terms, hits: kept };
  };

  for (const form of document.querySelectorAll("form.search")) {
    const input = form.querySelector("input");
    const empty = form.querySelector("template.search-empty");
    const list = document.createElement("ul");
    list.className = "results";
    list.id = `results-${Math.random().toString(36).slice(2, 8)}`;
    list.setAttribute("role", "listbox");
    list.hidden = true;
    form.append(list);
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-controls", list.id);
    input.setAttribute("aria-expanded", "false");
    let active = -1;

    const close = () => {
      list.hidden = true;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
      active = -1;
    };
    const select = (i) => {
      const items = [...list.querySelectorAll("[role=option]")];
      if (!items.length) return;
      active = (i + items.length) % items.length;
      items.forEach((el, n) => el.setAttribute("aria-selected", String(n === active)));
      input.setAttribute("aria-activedescendant", items[active].id);
      items[active].scrollIntoView({ block: "nearest" });
    };
    const render = () => {
      const q = input.value.trim();
      if (!q) return close();
      if (!index) return void load().then(render);
      const { terms, hits } = search(q);
      active = -1;
      list.innerHTML = "";
      if (!hits.length) {
        const li = document.createElement("li");
        li.className = "empty";
        li.innerHTML = empty ? empty.innerHTML : "";
        list.append(li);
      }
      hits.forEach(({ row }, n) => {
        const li = document.createElement("li");
        li.setAttribute("role", "option");
        li.id = `${list.id}-${n}`;
        li.setAttribute("aria-selected", "false");
        const a = document.createElement("a");
        a.href = new URL(row.u, root).href;
        a.innerHTML = `<b>${mark(row.t, terms)}</b>${row.s ? `<i>${mark(row.s, terms)}</i>` : `<i>${escapeHtml(row.c || "")}</i>`}<span>${snippet(row, terms)}</span>`;
        li.append(a);
        list.append(li);
      });
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
    };

    input.addEventListener("focus", () => void load());
    input.addEventListener("input", render);
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (list.hidden) render();
        select(active + 1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        select(active - 1);
      } else if (e.key === "Enter") {
        const a = list.querySelectorAll("[role=option] a")[active < 0 ? 0 : active];
        if (a) {
          e.preventDefault();
          location.href = a.href;
        }
      } else if (e.key === "Escape") {
        if (!list.hidden) {
          e.preventDefault();
          close();
        } else input.blur();
      }
    });
    form.addEventListener("submit", (e) => {
      const a = list.querySelector("[role=option] a");
      if (a) {
        e.preventDefault();
        location.href = a.href;
      }
    });
    document.addEventListener("click", (e) => {
      if (!form.contains(e.target)) close();
    });
  }

  // "/" anywhere but in a field jumps to the first search box
  document.addEventListener("keydown", (e) => {
    if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const input = [...document.querySelectorAll("form.search input")].find((i) => i.offsetParent !== null);
    if (!input) return;
    e.preventDefault();
    input.focus();
  });

  // the docs home opened with ?q= (the form sent without the script, or a link): the search runs at once
  const q = new URLSearchParams(location.search).get("q");
  const hero = document.querySelector("form.search-hero input");
  if (q && hero) {
    hero.value = q;
    hero.focus();
    load().then(() => hero.dispatchEvent(new Event("input")));
  }
})();
