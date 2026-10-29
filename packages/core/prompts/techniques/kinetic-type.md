# Technique: kinetic-type

The words are the picture. HTML text animated with GSAP, synced to the speaker's words.

- Split the on-screen text with SplitText into words (or letters) so each can move; style and animate
  `split.words` / `split.chars`. For a reveal from below, wrap each line in an `overflow: hidden` box that
  reaches well above the capitals (Turkish marks), or use SplitText's `mask: "lines"` with a line-height of
  at least 1.1.
- Every word enters on its own time from the transcript (relative to the scene start). The stressed word gets
  the strongest motion and the accent colour.
- Use the style's fonts and scale contrast: one hero word much larger than the rest. Variable fonts can
  animate `font-variation-settings` (for example width) as part of the motion.
- No crossfades between word groups; cut on the beat or move words out through the frame edges.
- Keep lines inside the safe area; measure with `max-width` and wrapping, not fixed line breaks.
