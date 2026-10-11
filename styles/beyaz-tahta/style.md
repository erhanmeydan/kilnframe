# beyaz-tahta

A whiteboard explainer: black marker drawings appear stroke by stroke on warm off-white paper, with one
muted red accent for circles, underlines and arrows. Simple, friendly and clear, like a good teacher sketching
while talking. Reference stills: `stills/a-metafor.png`, `stills/b-veri.png`, `stills/c-surec.png`.

## Look

- Warm off-white paper with very faint grain. Black ink for every drawing and all writing. Muted red only for
  the accent: a circle around a number, underlines, arrows, the one highlighted object.
- One marker: constant stroke width, round caps and joins, a slight seeded wobble so lines feel hand drawn.
  Line ends may overshoot a corner by a few pixels.
- Shading is only 45 degree parallel hatching. No fills, no gradients, no tone.
- Drawings are simple outlines built from few strokes, drawn larger than in the stills so they read on screen.

## Type

- Patrick Hand for all writing: numbers, labels, short notes and headlines. Turkish letters render from the
  font's own glyphs.
- No dashes in on-screen text.

## Motion

- Everything is drawn on: each stroke grows along its path. Order: outline, details, hatching, then the red
  accent last.
- Handwriting reveals letter by letter from left to right.
- Drawn lines never move, bounce or scale once they exist. Only the camera moves: a slow pan or zoom across
  one big sheet, following the drawing.
- Transition: the camera pans to an empty part of the sheet, or a quick wipe erases the board.

## How each technique looks in this style

| Technique    | Look                                                                                         |
| ------------ | -------------------------------------------------------------------------------------------- |
| canvas-draw  | The core of the style: strokes drawn on in order                                             |
| svg-draw     | Same marker strokes, built as SVG paths                                                      |
| diagram      | Outline icons joined by curvy red arrows, red underlines under each step                     |
| data-viz     | Hatched outline bars on a wobbly baseline, key bar in red, handwritten number circled in red |
| kinetic-type | Handwritten words written on, key word underlined or circled in red                          |
| ui-mockup    | A sketched wireframe: outline boxes, scribbled lines for text, a red arrow to the key button |
| code         | Short handwritten code lines in a sketched box                                               |
| motion-2d    | Not supported beyond the camera move, drawings stay still once drawn                         |
| three-3d     | Not supported                                                                                |
| particles    | Not supported                                                                                |

## User images

Photos and illustrations turn into ink on paper: grayscale, raised contrast, a multiply blend over the paper,
and the image draws on behind a hand-drawn outline that is drawn first. Screenshots sit in a hand-drawn frame;
the part being discussed gets a red marker circle or underline drawn on its word. Logos stay as they are,
placed on the paper with a drawn label line.

## Sound palette

Marker squeak and scratch while drawing, soft tap at the end of a stroke, quick swipe for erasing, light paper
rustle for camera pans.

## Forbidden

Colors other than black ink and the red accent, filled shapes, gradients, shadows, typed fonts, bouncing or
moving drawings, hands or markers visible in frame, fades.
