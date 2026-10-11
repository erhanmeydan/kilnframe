# data-viz / flat-veri

Proof scene for the `data-viz` technique in the flat-infografik style. The scene lives in
`styles/flat-infografik/examples/data-viz.html` (the style's golden example) and is rendered through the
pipeline fixture `examples/pipeline/flat-veri`.

What it exercises: a disc that bleeds off the frame grown with an animated `clip-path`, a counter driven by a
property setter (seek safe), a knockout where the part of the number inside the disc switches to the paper
colour (same clip path, so it stays exact while the disc grows), bars growing from the baseline, Sora with
Turkish letters, seeded SVG paper noise.

```bash
node packages/core/dist/cli.js render --plan examples/pipeline/flat-veri/plan.json \
  --scenes examples/pipeline/flat-veri/scenes --out out/flat-veri
```

## Result (2026-10-06, Apple M5 Max)

| Item    | Value                                                             |
| ------- | ----------------------------------------------------------------- |
| Output  | 1920x1080, 30000/1001 fps, 150 body frames + 2 x 24 handle frames |
| check   | 0 errors, 0 warnings                                              |
| Render  | 4.0 s (2D scenes are about 3 times faster than the 3D proof)      |
| Deliver | 0.4 s                                                             |

## Notes

- HyperFrames' `gsap_repeated_fromto_without_baseline` treats two non-DOM tween targets (plain objects driving
  setters) as the same element. `immediateRender: false` on the later one silences it without changing the
  result, because the setters are initialised by hand.
