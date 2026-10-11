# Technique: code

Code being written, diffs, terminal output, API calls.

- Monospace font from the style tokens if given; otherwise use the style's text font for labels and keep
  code short so it stays readable (at most 8 to 10 lines, 40 characters wide at 1080p).
- Syntax colouring by hand with spans, using only the style palette (keywords, strings, comments).
- Typing effect: tween a plain object whose `chars` setter writes `text.slice(0, Math.round(v))` into the
  line (setter pattern, not `onUpdate`, so any frame can be seeked directly); add a cursor block that blinks
  with a finite repeat.
- Diffs: removed lines strike or slide out, added lines slide in with the accent colour.
- Terminal: prompt, command typed, then output appears line by line.
- Highlight the one line the speaker talks about.
