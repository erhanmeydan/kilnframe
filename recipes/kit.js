// Shared by every recipe skeleton, inlined at its KIT placeholder. Reads the data block and the style's dress
// tokens (CSS custom properties on the stage), and works out where the graphics may go.
const KF = (() => {
  const stage = document.getElementById("SCENE_ID-stage");
  const data = JSON.parse(document.getElementById("SCENE_ID-data").textContent);
  const W = WIDTH;
  const H = HEIGHT;
  const short = Math.min(W, H);
  /** Pixels per unit, units measured on a 1080 px short side. */
  const u = short / 1080;
  const overlay = data.mode === "overlay";

  const token = (name, fallback = "") =>
    getComputedStyle(stage).getPropertyValue(`--${name}`).trim() || fallback;
  const num = (name, fallback) => {
    const v = parseFloat(token(name));
    return Number.isFinite(v) ? v : fallback;
  };
  const ease = (name, fallback) => token(`ease-${name}`, fallback);

  /**
   * The rectangle the graphics may use: the safe area, or beside the speaker in an overlay. With the speaker
   * in the middle of a wide frame, "column" asks for a narrow column at the left edge instead of the band
   * below the chin (taller content such as charts).
   */
  function region(prefer = "band") {
    const s = data.safeArea;
    const full = { x: s.left, y: s.top, w: W - s.left - s.right, h: H - s.top - s.bottom };
    if (!overlay || data.speakerSide === "none") return full;
    if (data.speakerSide === "left" && data.format !== "portrait") {
      const x = W * 0.52;
      return { x, y: full.y, w: W - s.right - x, h: full.h };
    }
    if (data.speakerSide === "right" && data.format !== "portrait") {
      return { x: full.x, y: full.y, w: W * 0.48 - full.x, h: full.h };
    }
    if (prefer === "column" && data.format === "landscape")
      return { x: full.x, y: full.y, w: Math.min(W * 0.28, full.w), h: full.h };
    // speaker in the middle, or a vertical frame: the band below the chin
    const y = H * (data.format === "portrait" ? 0.62 : 0.66);
    return { x: full.x, y, w: full.w, h: H - s.bottom - y };
  }

  /** Shrinks an element's font until it fits the box; the start size is the largest it may be. */
  function fit(el, maxW, maxH, startPx, minPx = startPx * 0.4) {
    let size = startPx;
    el.style.fontSize = `${size}px`;
    while (size > minPx && (el.scrollWidth > maxW + 1 || el.scrollHeight > maxH + 1)) {
      size -= Math.max(1, size * 0.04);
      el.style.fontSize = `${size}px`;
    }
    return size;
  }

  /** Loads the dress's fonts (head, num, body) before anything is measured. */
  async function fonts() {
    await Promise.all(
      ["head", "num", "body"].map((k) => {
        const family = token(`font-${k}`);
        return family ? document.fonts.load(`${num(`weight-${k}`, 400)} 100px ${family}`) : null;
      }),
    );
  }

  /** mulberry32: a seeded generator, so every render draws the same. */
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** A faint seeded speckle over the background, fullscreen only (over footage it reads as haze). */
  function speckle(layer) {
    const opacity = num("speckle", 0);
    if (overlay || opacity <= 0) return;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(W / 2);
    canvas.height = Math.round(H / 2);
    // the faintness lives on the element, so checks see a see-through layer, not an opaque picture
    canvas.style.cssText = `position:absolute;inset:0;width:100%;height:100%;mix-blend-mode:multiply;opacity:${opacity * 2}`;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(canvas.width, canvas.height);
    const r = rng(num("speckle-seed", 3));
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.round(r() * 255);
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    layer.appendChild(canvas);
  }

  /** The moment an item appears: a little before its word, never before the scene starts. */
  const at = (word, lead = 0.12) => Math.max(0, (word?.at ?? 0) - lead);

  /** Splits a text into word spans, so words can be coloured or moved one by one. */
  function words(el, text, cls) {
    el.textContent = "";
    return text
      .split(/\s+/)
      .filter(Boolean)
      .map((w, i, all) => {
        const span = document.createElement("span");
        span.className = cls;
        span.textContent = w;
        el.appendChild(span);
        if (i < all.length - 1) el.appendChild(document.createTextNode(" "));
        return span;
      });
  }

  const el = (tag, cls, parent) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    parent?.appendChild(e);
    return e;
  };

  const place = (e, r) => {
    e.style.left = `${r.x}px`;
    e.style.top = `${r.y}px`;
    e.style.width = `${r.w}px`;
    e.style.height = `${r.h}px`;
  };

  return {
    stage,
    data,
    W,
    H,
    u,
    overlay,
    token,
    num,
    ease,
    region,
    fit,
    fonts,
    rng,
    speckle,
    at,
    words,
    el,
    place,
  };
})();
