# Technique: diagram

Processes, steps, architectures, cause and effect.

- Three to five nodes at most; if the speech lists more, group them. Each node is an icon (kfIcon, for what the
  step is) and a short label in the style's node shape, connected by the style's connector (arrow, line, path).
- Lay out along a clear direction (left to right in landscape, top to bottom in portrait) with even rhythm
  but not a mechanical grid; the active step can be larger.
- Reveal step by step on the words that name each step: node arrives, connector draws to the next node
  (DrawSVG on the connector path).
- Show flow after the structure is built: a dot, dash or glow travelling along the connectors (MotionPath
  with the connector as its path).
- Keep labels short (one to three words, the speaker's language).
