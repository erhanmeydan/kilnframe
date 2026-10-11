# flat-infografik

Editorial explainer graphics built only from flat color shapes on warm sand. No gradients, no shadows, no
outlines. Clarity comes from geometry, scale contrast and one accent color. Reference stills:
`stills/a-metafor.png`, `stills/b-veri.png`, `stills/c-surec.png`, `stills/d-kompozisyon.png`.

## Look

- Sand background, teal for main shapes, charcoal for icons, type and baselines, coral as the single accent.
- Shapes share one corner radius and one stroke weight with round caps. Icons are built from primitives
  (circles, rounded rectangles, triangles), never from icon fonts or clip art.
- A very faint seeded paper noise sits on the background so it does not look like a blank screen.
- Leave generous negative space. Layout is asymmetric: content on two thirds, calm space on the rest.
- Avoid the stock icon look: every scene has one big scale contrast (a giant number, an oversized shape)
  and elements are composed, not lined up in an evenly spaced row.
- Hero composition (see `stills/d-kompozisyon.png`): a giant shape bleeding off one edge, an oversized number or word
  overlapping it, small accent elements placed off-grid. Use this at least once per video.
- Where text crosses a shape, the part inside the shape switches color (clip-path knockout) so it stays
  readable, e.g. charcoal on sand becomes sand on teal.

## Type

- Sora Bold for headlines, Sora ExtraBold for big numbers, Sora Medium for small labels. Sentence case or upper case, left
  aligned. No dashes in on-screen text.

## Motion

- Shapes pop in from their own base or center with a small overshoot. Bars and arrows grow from their
  origin. Numbers count up.
- One thing moves at a time, in reading order, synced to the spoken words.
- Coral accent arrives last and gets the strongest motion.
- Transition: a teal shape grows to fill the frame and becomes the next scene's background, or a wipe made
  of a flat shape. No fades.

## How each technique looks in this style

| Technique    | Look                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------- |
| data-viz     | Flat bars with rounded tops on a charcoal baseline, no grid, accent bar coral, big Sora number     |
| diagram      | Teal circles or rounded rectangles holding charcoal icons, coral arrows with round caps, step dots |
| motion-2d    | Layered flat shapes, scale and position animation, shape morphs between primitives                 |
| kinetic-type | Sora words slide and scale in blocks, key word in coral                                            |
| svg-draw     | Strokes draw on with round caps in teal or coral                                                   |
| ui-mockup    | Flat device frame in charcoal, screen built from flat blocks, no screenshots unless provided       |
| code         | Charcoal card, monospace text in sand, coral highlight line                                        |
| particles    | Small flat circles and squares in palette colors, seeded                                           |
| three-3d     | Not supported. Abstract ideas become flat metaphors instead                                        |
| canvas-draw  | Not supported                                                                                      |

## User images

Photos and illustrations become a two-colour duotone of the palette (an SVG feColorMatrix or a
luminosity mask over flat colour), cut into a flat rectangle or circle with no shadow. Screenshots sit in a
flat device frame and are pointed at with a solid arrow and a flat highlight block. Logos stay untouched on a
flat colour panel.

## Sound palette

Soft pop for each shape, short tick for count-ups, light whoosh for transitions, subtle click for arrows.

## Forbidden

Gradients, drop shadows, outlines around filled shapes, 3D, photos, textures other than the faint paper
noise, centered symmetric layouts, more than one accent color, fade-in entrances.
