# Technique: canvas-draw

Hand-drawn feel: sketches and scribbles drawn stroke by stroke on a 2D canvas.

- Prepare the drawing as a list of strokes (arrays of points) at build time. Add a seeded wobble to points
  once; never randomise per frame.
- `draw(t)` clears the canvas and draws every stroke up to the length reached at time t (strokes that are
  finished are drawn fully, the current one partially), so any frame can be rendered directly.
- Constant stroke width with round caps and joins as the style says; hatching is a set of short parallel
  strokes drawn after the outline.
- Handwritten text uses the style's handwriting font, revealed with a left to right clip.
