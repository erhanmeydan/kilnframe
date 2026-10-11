# Technique: three-3d

A Three.js scene drawn on a full-frame `<canvas>` inside the scene root, with HTML text layered above it.

- One `WebGLRenderer`, one scene, one camera. Build all geometry once; in `draw(t)` only move, scale, show or
  hide objects and render. Never create geometry or materials per frame.
- Objects are built from primitives (boxes, `RoundedBoxGeometry`, spheres, cylinders, capsules, tubes) or from
  `THREE.Shape` + `ExtrudeGeometry` with bevels for icons, gears, arrows and letters.
- Animate with plain functions of time (ease helpers, drop and bounce curves) inside `draw(t)`; the GSAP
  timeline only drives `t` and the HTML text.
- Shadows: one shadow-casting light, map size 1024. Keep the scene light: no environment maps, no
  post-processing passes.
- Film grain, vignettes and glows are separate 2D canvases or CSS layers above the WebGL canvas, redrawn from
  `t` (seeded).
- A slow camera move gives life; never shake the camera.
