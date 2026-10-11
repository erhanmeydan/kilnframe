# Technique: kinetic-type

The words are the picture. HTML text animated with GSAP, synced to the speaker's words.

- Split the on-screen text into words (or letters) as `display: inline-block` spans so each can move.
- Every word enters on its own time from the transcript (relative to the scene start). The stressed word gets
  the strongest motion and the accent colour.
- Use the style's fonts and scale contrast: one hero word much larger than the rest. Variable fonts can
  animate `font-variation-settings` (for example width) as part of the motion.
- Masks for reveals: wrap a word in an `overflow: hidden` box and move the word in from below.
- No crossfades between word groups; cut on the beat or move words out through the frame edges.
- Keep lines inside the safe area; measure with `max-width` and wrapping, not fixed line breaks.
