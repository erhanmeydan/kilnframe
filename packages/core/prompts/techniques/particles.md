# Technique: particles

Flows, gatherings, bursts, data streams.

- Generate particle positions once with a seeded generator (mulberry32) at build time. Every frame computes
  each particle's position from time (for example `p0 + v * t` with easing), never by integrating over
  previous frames.
- Canvas 2D for up to a few thousand particles; Three.js `Points` with a buffer attribute for more. Update
  the buffer from time in `draw(t)`.
- Shapes and colours follow the style (clay pebbles, paper confetti, ink dots, light dots).
- Particles serve the story: they gather into a shape, flow from A to B, or burst on the stressed word.
