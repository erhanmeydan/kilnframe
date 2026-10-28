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

  // ---------- how the style draws: "flat" shapes that pop and slide, or "drawn" marker strokes ----------
  const drawn = token("render", "flat") === "drawn";
  const SVG = "http://www.w3.org/2000/svg";
  const wobbleRng = rng(num("wobble-seed", 21));
  /** The marker's width in pixels. */
  const strokeW = () => num("stroke", 7) * u;
  let inkLayer = null;
  /** One SVG over the plate and under the text, holding every line and outline. */
  function ink() {
    if (inkLayer) return inkLayer;
    inkLayer = document.createElementNS(SVG, "svg");
    inkLayer.setAttribute("width", String(W));
    inkLayer.setAttribute("height", String(H));
    inkLayer.setAttribute("viewBox", `0 0 ${W} ${H}`);
    inkLayer.style.cssText = "position:absolute;left:0;top:0;overflow:visible";
    const after =
      document.getElementById("SCENE_ID-plate") ?? document.getElementById("SCENE_ID-texture");
    stage.insertBefore(inkLayer, after ? after.nextSibling : stage.firstChild);
    return inkLayer;
  }

  /** A polyline as a path; drawn styles get a slow seeded wobble across it, like a marker. */
  function pathOf(points, amp = drawn ? num("wobble", 1.5) * u : 0) {
    const pts = [];
    for (let i = 0; i < points.length - 1; i++) {
      const [x0, y0] = points[i];
      const [x1, y1] = points[i + 1];
      const len = Math.hypot(x1 - x0, y1 - y0) || 1;
      const n = amp ? Math.max(1, Math.ceil(len / (8 * u))) : 1;
      const nx = -(y1 - y0) / len;
      const ny = (x1 - x0) / len;
      const phase = wobbleRng() * 6.28;
      const freq = (0.012 + wobbleRng() * 0.01) / u;
      for (let k = 0; k < n; k++) {
        const f = k / n;
        const off = amp * Math.sin(phase + f * len * freq);
        pts.push([x0 + (x1 - x0) * f + nx * off, y0 + (y1 - y0) * f + ny * off]);
      }
    }
    pts.push(points[points.length - 1]);
    return pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join("");
  }

  function strokePath(d, key, width = strokeW(), parent = ink()) {
    const p = document.createElementNS(SVG, "path");
    p.setAttribute("d", d);
    p.setAttribute("fill", "none");
    p.style.stroke = key ? "var(--accent)" : "var(--line, var(--ink))";
    p.setAttribute("stroke-width", String(width));
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("stroke-linejoin", "round");
    parent.appendChild(p);
    return p;
  }

  /** A loop a little more than one turn, as a marker circles something. */
  function loopPoints(r, turns = 1.06) {
    const pts = [];
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const start = -2.2 + wobbleRng() * 0.6;
    for (let k = 0; k <= 64; k++) {
      const a = start + (k / 64) * Math.PI * 2 * turns;
      const q = 1 + 0.03 * Math.sin(a * 3);
      pts.push([cx + (Math.cos(a) * r.w * q) / 2, cy + (Math.sin(a) * r.h * q) / 2]);
    }
    return pts;
  }

  /** 45 degree hatching inside a box: the only shading a drawn style has. */
  function hatchPaths(r, key, g) {
    const sp = num("hatch-spacing", 14) * u * Math.SQRT2;
    const inset = 9 * u;
    const x0 = r.x + inset;
    const x1 = r.x + r.w - inset;
    const y0 = r.y + inset;
    const y1 = r.y + r.h - inset;
    const out = [];
    for (let c = x0 - (y1 - y0); c < x1; c += sp) {
      let ya = y1;
      let xa = c;
      let yb = y0;
      let xb = c + (y1 - y0);
      if (xa < x0) {
        ya -= x0 - xa;
        xa = x0;
      }
      if (xb > x1) {
        yb += xb - x1;
        xb = x1;
      }
      if (ya - yb < 6 * u) continue;
      out.push(
        strokePath(
          pathOf(
            [
              [xa, ya],
              [xb, yb],
            ],
            0.6 * u,
          ),
          key,
          num("hatch-width", 4) * u,
          g,
        ),
      );
    }
    return out;
  }

  /**
   * A shape of the scene. Flat: a div with the given class (the skeleton's CSS paints it). Drawn: marker
   * outlines in the ink layer; "bar" is open at the bottom and hatched, "hero" and "block" are left out.
   */
  function shape(kind, r, { cls = "", key = false, parent = stage } = {}) {
    if (!drawn) {
      const e = el("div", cls, parent);
      place(e, r);
      return { el: e, paths: [], hatch: [] };
    }
    const g = document.createElementNS(SVG, "g");
    ink().appendChild(g);
    const part = { el: g, paths: [], hatch: [] };
    if (kind === "hero" || kind === "block") return part;
    const o = 4 * u;
    // a small mark gets a finer pen, or its outline closes up into a blot
    const pen = Math.min(strokeW(), Math.max(2, Math.min(r.w, r.h) * 0.11));
    if (kind === "circle") part.paths.push(strokePath(pathOf(loopPoints(r)), key, pen, g));
    else if (kind === "bar") {
      part.paths.push(
        strokePath(
          pathOf([
            [r.x, r.y + r.h - 2 * u],
            [r.x, r.y],
            [r.x + r.w, r.y - 2 * u],
            [r.x + r.w, r.y + r.h - 2 * u],
          ]),
          key,
          strokeW(),
          g,
        ),
      );
      part.hatch = hatchPaths(r, key, g);
    } else {
      // a box: four sides in one stroke, the last one overshooting its corner a little
      part.paths.push(
        strokePath(
          pathOf([
            [r.x, r.y],
            [r.x + r.w, r.y - o / 2],
            [r.x + r.w + o / 2, r.y + r.h],
            [r.x, r.y + r.h + o / 2],
            [r.x - o / 2, r.y - o * 2],
          ]),
          key,
          pen,
          g,
        ),
      );
    }
    return part;
  }

  /** A line through points (a connector, a baseline, a rule). */
  function line(points, { key = false, width } = {}) {
    const p = strokePath(pathOf(points), key, width ?? strokeW());
    return { el: p, paths: [p], hatch: [] };
  }

  /** Draws paths on one after another at marker speed; returns when the last one is done. */
  function drawOn(tl, paths, t, speed) {
    let at = t;
    for (const p of paths) {
      const len = Math.max(1, p.getTotalLength());
      p.style.strokeDasharray = `${len} ${len}`;
      const d = Math.min(0.9, len / (speed * u));
      // hidden until the pen gets there: a round cap would otherwise show as a dot
      tl.fromTo(p, { opacity: 0 }, { opacity: 1, duration: 0.01 }, at);
      tl.fromTo(
        p,
        { strokeDashoffset: len },
        { strokeDashoffset: 0, duration: d, ease: "none" },
        at,
      );
      at += d;
    }
    return at;
  }

  /**
   * Text that is masked on purpose while it enters (a wipe, a rise out of its mask): the layout check would
   * otherwise take the half-shown text for text hidden under something.
   */
  function maskedOnPurpose(e) {
    for (const n of [e, ...e.querySelectorAll("*")])
      n.setAttribute("data-layout-allow-occlusion", "");
  }

  /** Writing appears letter by letter from left to right (a wipe at handwriting speed). */
  function writeOn(tl, e, t) {
    maskedOnPurpose(e);
    // a written line has no rise mask: let its descenders out of the box a flat style would clip
    const box = e.parentElement;
    if (box && box !== stage && getComputedStyle(box).overflow === "hidden")
      box.style.overflow = "visible";
    const letters = Math.max(1, (e.textContent ?? "").length);
    // the writing is done before the scene ends, however late its word comes
    const d = Math.max(
      0.25,
      Math.min(1.6, letters / num("letters-per-second", 14), data.durationS - 0.3 - t),
    );
    tl.fromTo(e, { opacity: 0 }, { opacity: 1, duration: 0.01 }, t);
    tl.fromTo(
      e,
      { clipPath: "inset(-20% 100% -20% -2%)" },
      { clipPath: "inset(-20% -2% -20% -2%)", duration: d, ease: "none" },
      t,
    );
    return t + d;
  }

  /**
   * Brings a part in at time t. Flat styles pop ("pop"), grow ("grow-x", "grow-y"), slide up out of a mask
   * ("rise") or in from the left ("slide"); drawn styles draw strokes on and write text on, and nothing that
   * is drawn moves afterwards. Returns when the entrance is over.
   */
  function enter(tl, part, t, how) {
    const target = part.el ?? part;
    if (drawn) {
      if (part.paths?.length || part.hatch?.length) {
        const end = drawOn(tl, part.paths ?? [], t, num("draw-speed", 2400));
        return drawOn(tl, part.hatch ?? [], end, num("hatch-speed", 12000));
      }
      if (how === "rise" || how === "slide" || how === "text") return writeOn(tl, target, t);
      tl.fromTo(target, { opacity: 0 }, { opacity: 1, duration: 0.01 }, t);
      return t;
    }
    const enterEase = ease("enter", "back.out(1.6)");
    const growEase = ease("grow", "power3.out");
    if (part.paths?.length && how === "draw")
      return drawOn(tl, part.paths, t, num("draw-speed", 2400));
    if (how === "pop")
      tl.fromTo(target, { scale: 0 }, { scale: 1, duration: 0.5, ease: enterEase }, t);
    else if (how === "grow-x")
      tl.fromTo(target, { scaleX: 0 }, { scaleX: 1, duration: 0.6, ease: growEase }, t);
    else if (how === "grow-y")
      tl.fromTo(target, { scaleY: 0 }, { scaleY: 1, duration: 0.7, ease: growEase }, t);
    else if (how === "rise") {
      maskedOnPurpose(target);
      tl.fromTo(target, { opacity: 0 }, { opacity: 1, duration: 0.01 }, t);
      tl.fromTo(target, { yPercent: 105 }, { yPercent: 0, duration: 0.55, ease: enterEase }, t);
    } else if (how === "slide") {
      tl.fromTo(target, { opacity: 0 }, { opacity: 1, duration: 0.01 }, t);
      tl.fromTo(target, { x: -24 * u }, { x: 0, duration: 0.5, ease: enterEase }, t);
    } else tl.fromTo(target, { opacity: 0 }, { opacity: 1, duration: 0.01 }, t);
    return t + 0.5;
  }

  /** A box of an element in stage pixels. */
  function boxOf(e) {
    const s = stage.getBoundingClientRect();
    const b = e.getBoundingClientRect();
    return { x: b.left - s.left, y: b.top - s.top, w: b.width, h: b.height };
  }

  /** The box of an element's text itself, not of the element (which may be wider than its words). */
  function textBox(e) {
    const range = document.createRange();
    range.selectNodeContents(e);
    const s = stage.getBoundingClientRect();
    const b = range.getBoundingClientRect();
    return { x: b.left - s.left, y: b.top - s.top, w: b.width, h: b.height };
  }

  /**
   * Marks the key words or number. Flat: a small pop (the dress paints the block). Drawn: a red marker
   * underline, or a loop around it ("circle"), drawn after the writing.
   */
  function mark(tl, els, t, how = "underline") {
    if (!els.length) return t;
    if (!drawn) {
      tl.fromTo(
        els,
        { scale: 0.7 },
        { scale: 1, duration: 0.5, ease: "back.out(2.4)", transformOrigin: "0% 80%" },
        t,
      );
      return t + 0.5;
    }
    let end = t;
    for (const e of els) {
      const b = textBox(e);
      const part =
        how === "circle"
          ? {
              paths: [
                strokePath(
                  pathOf(
                    loopPoints({
                      x: b.x - b.w * 0.13,
                      y: b.y + b.h * 0.06,
                      w: b.w * 1.26,
                      h: b.h * 0.88,
                    }),
                  ),
                  true,
                ),
              ],
            }
          : line(
              [
                [b.x - 4 * u, b.y + b.h * 0.94],
                [b.x + b.w + 6 * u, b.y + b.h * 0.92],
              ],
              { key: true },
            );
      end = drawOn(tl, part.paths, end, num("draw-speed", 2400));
    }
    return end;
  }

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
    drawn,
    shape,
    line,
    enter,
    mark,
    boxOf,
  };
})();
