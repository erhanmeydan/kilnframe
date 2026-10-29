# Technique: svg-draw

Lines that draw themselves: strokes, arrows, connectors, underlines, outlines, masks.

- Inline `<svg>` with a `viewBox` equal to the canvas size so coordinates are pixels.
- Draw-on with DrawSVG: `tl.fromTo(path, { drawSVG: "0%" }, { drawSVG: "100%" }, t)`; `"50% 50%"` as the
  start grows a stroke from its middle. Shapes morph into each other with MorphSVG, and a marker or arrow
  head can travel along a drawn path with MotionPath.
- Stroke width, caps and joins come from the style tokens. Draw in a natural order (outline, details,
  accents) at a steady speed: duration proportional to path length.
- Arrows: draw the shaft, then pop the head (a separate small path) when the shaft arrives.
- Masks and reveals: animate a `clipPath` rectangle or circle; keep `clipPathUnits` in user space.
- For a hand-drawn feel (only if the style asks for it), perturb path points with a seeded generator at
  build time, never per frame.
