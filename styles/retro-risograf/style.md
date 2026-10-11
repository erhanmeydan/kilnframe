# retro-risograf

A risograph print come to life: three flat spot inks (teal, warm red, mustard) on cream paper, slightly out
of register, overprinting where they meet, with grainy uneven ink and coarse halftone shading. Warm,
handmade and a little imperfect. Reference stills: `stills/a-metafor.png`, `stills/b-veri.png`,
`stills/c-surec.png`.

## Look

- Cream paper with faint grain. Only three inks. Dark tones exist only where two inks overprint (multiply
  blend), never as a separate ink.
- Every shape is printed as one or more ink layers. Layers are offset by a few pixels (misregistration).
- Ink coverage is grainy: a seeded noise mask removes small specks so ink never looks digital.
- Shading is done with coarse halftone dots in one ink, never with gradients.
- Shapes are bold, flat pictograms built from circles, rounded rectangles and simple curves (see the
  microphone in `a-metafor`). No realistic illustration, no rendered light.

## Type

- Bricolage Grotesque ExtraBold for headlines and numbers, printed as two overprinting inks with a small
  offset (as the "73%" in `b-veri`). Bricolage SemiBold for small labels.
- No dashes in on-screen text.

## Motion

- Paper stays still, inks move. Each ink layer of an object arrives separately and lands slightly off, like a
  print pass: the object "prints" onto the page.
- On accents the registration wobbles a little (seeded) and settles.
- Bars grow from the baseline with their offset ink layer following one beat later. Numbers count up.
- Transition: a new paper sheet slides over the frame, or one ink floods the whole frame. No fades.

## How each technique looks in this style

| Technique    | Look                                                                              |
| ------------ | --------------------------------------------------------------------------------- |
| data-viz     | Ink bars with an offset second-ink shadow, accent bar red, big overprinted number |
| diagram      | Pictogram icons inside mustard ink circles, red block arrows, halftone shading    |
| motion-2d    | Flat ink shapes printing in and moving, overprint where they cross                |
| kinetic-type | Bricolage words printed in two offset inks, stressed word in red                  |
| svg-draw     | Thick ink strokes with grainy edges                                               |
| ui-mockup    | A simplified screen as flat ink blocks, no real screenshots unless provided       |
| code         | Short code lines printed in teal on a mustard card                                |
| particles    | Ink dots and confetti specks in the three inks, seeded                            |
| three-3d     | Not supported                                                                     |
| canvas-draw  | Not supported                                                                     |

## User images

Images become two-ink risograph prints: split into two of the style's inks (duotone through SVG filters),
the two layers slightly misregistered, with coarse grain. Screenshots get the same two-ink print with a
highlighter ink block over the discussed part. Logos keep their own colours on a plain paper panel.

## Sound palette

Paper slide, soft print thunk when an ink layer lands, light paper rustle on transitions, dry tick for
count-ups.

## Forbidden

A fourth ink color, gradients, glossy or 3D shading, realistic detailed illustration, clean digital edges
without ink texture, perfect registration everywhere, fades.
