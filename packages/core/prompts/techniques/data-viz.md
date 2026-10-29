# Technique: data-viz

Numbers made visible: counters, bars, lines, pies, rankings.

- Use only numbers that appear in the plan or the speech. Never invent data. If the speech gives one number,
  show one number big and support it with a simple visual (a bar against a full track, a share of a circle).
- Build charts with SVG or HTML blocks scaled from the data; D3's scales and shapes (`d3.scaleLinear`,
  `d3.arc`, `d3.pie`, `d3.line`) do the geometry, GSAP does the motion; label values directly on the chart, no legends
  when a label can sit on the mark. No grid lines unless the style asks for them.
- Counters: tween a plain object whose `value` setter writes `Math.round(v)` into the text node (the same
  setter pattern as the canvas driver, so seeking to any frame shows the right number; do not rely on
  `onUpdate`). Use tabular figures (`font-variant-numeric: tabular-nums`) so digits do not jump. Format with the speaker's
  locale (Turkish: "73%", "1.250", "3,5").
- Bars grow from their baseline (`scaleY` with `transform-origin: bottom`), lines draw on (DrawSVG),
  pies and donuts grow by tweening their arcs' end angles and redrawing with `d3.arc`. An icon (kfIcon) can
  say what a number counts.
- The key value gets the accent colour and lands on the word that says it.
