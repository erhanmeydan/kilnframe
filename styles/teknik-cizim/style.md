# teknik-cizim

A blueprint: precise thin off-white line drawings on deep blueprint blue with a faint grid, dashed center
lines, dimension lines and small annotations, plus one amber accent for the signal and the measured value.
Engineered, exact, calm. Reference stills: `stills/a-metafor.png`, `stills/b-veri.png`, `stills/c-surec.png`.

## Look

- Deep blueprint blue with a faint minor grid and a slightly stronger major grid. Off-white lines with a
  subtle chalky texture (seeded SVG displacement). Amber only for the signal, connecting lines and the
  measured highlight.
- Uniform thin outline weight for objects, thinner construction lines. No fills except 45 degree hatching.
- Drafting language is the identity: dashed center lines through components, center marks on circles,
  dimension lines with arrowheads and extension lines. Every scene has at least one of these (see A and B).
- Objects are front view outline drawings with moderate detail, never exploded views.
- Leave the left third as empty grid for the headline.

## Type

- Space Grotesk for headlines (solid) and big numbers (outline only, as in `b-veri`).
- IBM Plex Mono for dimension values, labels and notes, small and precise.
- No dashes in on-screen text.

## Motion

- Everything draws on in drafting order: construction and center lines, then outlines, then dimensions and
  annotations.
- Dimension lines grow from their extension lines, then the value types on. Numbers count up.
- An amber signal travels along circuit lines as a short bright dash.
- Camera moves are precise pans and zooms aligned to the grid. Transition: zoom into a detail that becomes the
  next drawing. No fades.

## How each technique looks in this style

| Technique    | Look                                                                                |
| ------------ | ----------------------------------------------------------------------------------- |
| svg-draw     | The core: outline drawings drawing on in drafting order                             |
| diagram      | Outline components joined by right-angle amber circuit lines with junction dots     |
| data-viz     | Hatched outline bars, highlight bar in amber with a dimension line, outlined number |
| particles    | Small amber signal dots flowing along grid lines, seeded                            |
| ui-mockup    | A wireframe of the interface as a drafting drawing with dimensions                  |
| code         | IBM Plex Mono lines typed on inside an outlined frame                               |
| kinetic-type | Outlined Space Grotesk words drawing on stroke by stroke                            |
| motion-2d    | Outline shapes moving along grid axes                                               |
| three-3d     | Only as orthographic wireframe line drawings, no shaded 3D                          |
| canvas-draw  | Not supported, lines are precise, not hand drawn                                    |

## User images

Images become blueprints: inverted to light lines on the blueprint blue (grayscale, invert, screen blend),
inside a drafting frame with corner marks and a dimension line along one side. Screenshots sit in a
drafting frame and the discussed part gets a thin callout box with a leader line and a label in IBM Plex
Mono. Logos are placed untouched inside a drafting frame.

## Sound palette

Fine pen scratch while drawing, soft drafting ruler click, short electronic blip for the travelling signal,
quiet paper slide for camera moves.

## Forbidden

Filled shapes, gradients, glow, colors other than off-white and amber, hand-drawn wobble, exploded views,
perspective, fades.
