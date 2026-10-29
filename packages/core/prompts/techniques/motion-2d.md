# Technique: motion-2d

Layered 2D composition: shapes, cards, icons and type moved with GSAP.

- Build the end state in HTML/CSS (absolutely positioned layers inside the root), then animate from start
  states with `gsap.fromTo`. Icons come from kfIcon (Lucide line icons)
  dressed in the style, or inline SVG built from primitives; never icon fonts or images.
- Transformed elements are block level with a real size (`display: block` or flex items with width/height).
- Choreograph in reading order with the timeline's position parameter; overlap entrances slightly
  (`"<0.08"`) instead of chaining them flat.
- Use the style's eases and durations from tokens.json. Shape morphs are done with MorphSVG
  (any two paths, no equal point counts needed) or by animating border-radius, scale and clip-path.
- Depth is suggested with the style's own means (shadows only if the style allows them).
