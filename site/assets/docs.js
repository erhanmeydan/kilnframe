// kilnframe.com docs: on a phone the tree folds behind the Contents button, and opens on the current page.
(() => {
  const button = document.querySelector(".docs-menu");
  const side = document.getElementById("docs-side");
  if (!button || !side) return;
  button.addEventListener("click", () => {
    const open = side.classList.toggle("open");
    button.setAttribute("aria-expanded", String(open));
    if (open) side.querySelector("[aria-current]")?.scrollIntoView({ block: "nearest" });
  });
})();
