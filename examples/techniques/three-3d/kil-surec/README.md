# three-3d / kil-surec

First proof scene for M1: one hand-written kil-lacivert composition rendered end to end with HyperFrames.
Reference still: `styles/kil-lacivert/stills/c-surec.png`.

What it exercises: Three.js clay objects built from extruded shapes, seeded procedural clay bump texture,
the style's three lights and shadows, drop and squash motion, growing arrows, an accent burst, slow camera
push, seeded film grain, vignette, warm key glow, and a Barlow Condensed headline with Turkish letters
(Ü, Ç) animated by GSAP.

## Run

```bash
node scripts/sync-vendor.mjs examples/techniques/three-3d/kil-surec
cd examples/techniques/three-3d/kil-surec
../../../../packages/core/node_modules/.bin/hyperframes check
../../../../packages/core/node_modules/.bin/hyperframes render --fps 30000/1001 -o renders/kil-surec.mp4
```

## Result (2026-10-06, MacBook Pro, Apple M5 Max)

| Item        | Value                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------- |
| HyperFrames | 0.8.133                                                                                   |
| Output      | 1920x1080, 30000/1001 fps, H.264, 150 frames, 5.005 s                                     |
| Render time | 7.2 s total (setup 1.2 s, capture 3.4 s, encode 2.5 s)                                    |
| Capture     | screenshot capture, hardware GPU, 5 workers                                               |
| File size   | 85 MB at the default `looks` quality (CRF 16); grain makes the bitrate very high          |
| check       | 0 errors; 2 structure warnings (single file, no sub-composition), accepted for this proof |

## Notes

- Three.js 0.186 removed `PCFSoftShadowMap`; `PCFShadowMap` is used.
- Turkish capitals with marks (Ü) need line-height of at least about 1.05, otherwise the layout check flags
  overlapping lines.
- The 3D frame is drawn from a linear GSAP tween's property setter, so every seek repaints the exact time.
