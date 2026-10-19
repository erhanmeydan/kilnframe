// kilnframe.com: the newest release's version, the visitor's own system first, the promo video in a dialog and
// the benchmark clips playing under the pointer. The download links need no script:
// releases/latest/download/... always gives the newest installers.
(() => {
  const repo = "erhanmeydan/kilnframe";
  const tr = document.documentElement.lang === "tr";

  // Windows visitors see the Windows button first
  if (/Windows/i.test(navigator.userAgent)) {
    const win = document.querySelector("[data-os='windows']");
    const mac = document.querySelector("[data-os='mac']");
    if (win && mac) {
      mac.before(win);
      win.classList.add("primary");
      mac.classList.remove("primary");
    }
  }

  // the promo video opens in a dialog
  const dialog = document.querySelector("dialog.player");
  const player = dialog?.querySelector("video");
  for (const button of document.querySelectorAll("[data-play]"))
    button.addEventListener("click", () => {
      if (!dialog || !player) return;
      player.src = button.dataset.play;
      dialog.showModal();
      void player.play().catch(() => {});
    });
  dialog?.addEventListener("close", () => player?.pause());
  dialog?.querySelector("[data-close]")?.addEventListener("click", () => dialog.close());
  dialog?.addEventListener("click", (e) => e.target === dialog && dialog.close());

  // the looping clips play only while they are on screen (and start even where autoplay is held back)
  if ("IntersectionObserver" in window) {
    const watch = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) void e.target.play().catch(() => {});
          else e.target.pause();
        }
      },
      { threshold: 0.25 },
    );
    for (const video of document.querySelectorAll("video[autoplay]")) watch.observe(video);
  }

  // benchmark clips play while the pointer is on them (and on a tap on touch screens)
  for (const video of document.querySelectorAll(".bench video")) {
    const play = () => void video.play().catch(() => {});
    video.addEventListener("mouseenter", play);
    video.addEventListener("mouseleave", () => video.pause());
    video.addEventListener("click", () => (video.paused ? play() : video.pause()));
  }

  // benchmark filter: by how the model is reached, or what a run costs; the table follows the clips
  const filters = document.querySelectorAll(".bench-filter button");
  for (const button of filters) {
    button.addEventListener("click", () => {
      const want = button.dataset.filter;
      for (const b of filters) b.setAttribute("aria-pressed", String(b === button));
      for (const el of document.querySelectorAll(".bench figure, .runs tbody tr")) {
        el.hidden =
          want !== "all" &&
          !(want === "cheap" ? el.hasAttribute("data-cheap") : el.dataset.via === want);
      }
    });
  }

  // the table sorts by time or by price; a second click turns the order round
  for (const button of document.querySelectorAll(".runs th button")) {
    button.addEventListener("click", () => {
      const col = Number(button.dataset.sortCol);
      const dir = button.dataset.dir === "asc" ? "desc" : "asc";
      for (const b of document.querySelectorAll(".runs th button")) delete b.dataset.dir;
      button.dataset.dir = dir;
      const body = button.closest("table").tBodies[0];
      const value = (row) => Number(row.cells[col].dataset.sort);
      [...body.rows]
        .sort((a, b) => (dir === "asc" ? value(a) - value(b) : value(b) - value(a)))
        .forEach((row) => body.append(row));
    });
  }

  // the mailing list: Kit takes the address and sends its confirmation email; the page stays where it is
  for (const form of document.querySelectorAll("form.list")) {
    const status = form.querySelector(".list-status");
    const button = form.querySelector("button");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!status || !button) return;
      button.disabled = true;
      status.textContent = tr ? "Gönderiliyor..." : "Sending...";
      fetch(form.action, {
        method: "POST",
        body: new FormData(form),
        headers: { Accept: "application/json" },
      })
        .then((r) => r.json().then((body) => ({ ok: r.ok, body })))
        .then(({ ok, body }) => {
          if (!ok || body.status !== "success") throw new Error();
          form.reset();
          status.textContent = tr
            ? "Neredeyse tamam: e-postana gelen onay bağlantısına tıkla."
            : "Almost there: click the confirmation link we just emailed you.";
        })
        .catch(() => {
          status.textContent = tr
            ? "Gönderilemedi. Adresi kontrol edip yeniden dene."
            : "That did not go through. Check the address and try again.";
        })
        .finally(() => (button.disabled = false));
    });
  }

  // the version line stays hidden when GitHub cannot be reached (or the repository is still private)
  fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json" },
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((release) => {
      if (!release?.tag_name) return;
      const date = new Date(release.published_at).toLocaleDateString(tr ? "tr-TR" : "en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
      });
      const version = release.tag_name.replace(/^v/, "");
      for (const el of document.querySelectorAll("[data-version]"))
        el.textContent = tr ? `Sürüm ${version} · ${date}` : `Version ${version} · ${date}`;
    })
    .catch(() => {});
})();
