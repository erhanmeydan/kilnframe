# cam-arayuz

Minimal modern tech: frosted glass panels floating over a dark graphite background, with soft blurred mint
and slate light shapes glowing through the glass. Calm, premium, precise. The natural home for product, UI and
data scenes. Reference stills: `stills/a-metafor.png`, `stills/b-veri.png`, `stills/c-surec.png`.

## Look

- Dark graphite background. Behind the glass, two or three large, heavily blurred light shapes in mint and
  slate, slowly drifting. They are what makes the frosted glass visible; never show them as hard shapes.
- Glass panels: faint white fill, strong backdrop blur, thin light border, subtle top inner highlight, large
  soft shadow, generous corner radius.
- One accent, soft mint, for the active element: highlighted bar, active tile, connecting line, toggle. Active
  elements get a mint border and a soft mint glow.
- Icons are thin 2px outline pictograms built from SVG primitives.
- Content on the right two thirds, the left third calm for the headline.

## Type

- Inter Extra Light for big numbers and headlines, Inter Medium for small UI labels. Light text on dark.
- No dashes in on-screen text.

## Motion

- Glass panels rise slightly and come into focus (blur to sharp) with a smooth expo ease, staggered.
- Bars, lines and waveforms grow from their origin. Numbers count up.
- Activation: border and glow shift to mint, a tiny scale up.
- An optional UI cursor moves on smooth curves and clicks with a small ripple (for ui-mockup scenes).
- Transition: the camera pushes into a glass panel until it fills the frame and becomes the next scene.
  No fades.

## How each technique looks in this style

| Technique    | Look                                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------- |
| ui-mockup    | The core: glass cards, toggles, buttons, cursor and clicks; real screenshots sit on glass if provided |
| data-viz     | A glass dashboard card, rounded bars, mint highlight bar, thin big number counting up                 |
| diagram      | Glass tiles with outline icons, joined by a thin mint line with nodes, active tile glowing            |
| code         | A glass terminal or editor panel, monospace text, mint highlighted line, typed on                     |
| kinetic-type | Thin Inter words rising into focus, key word in mint                                                  |
| motion-2d    | Glass cards moving and stacking in shallow depth                                                      |
| particles    | Small soft light dots drifting behind the glass, seeded                                               |
| svg-draw     | Thin mint lines drawing on between elements                                                           |
| three-3d     | Only shallow CSS depth (stacked glass), no 3D objects                                                 |
| canvas-draw  | Not supported                                                                                         |

## User images

Images sit in frosted glass cards: rounded corners from the tokens, a soft shadow and a thin light border,
sliding in with the style's ease. Photos keep their colour but a little desaturated. Screenshots are the
star of this style: shown inside a glass window frame, with a soft glowing highlight box and a cursor moving
to the part the words name. Logos sit on a glass chip.

## Sound palette

Soft UI ticks and clicks, gentle airy whoosh for panels, subtle rising chime for activation, very quiet low
hum bed.

## Forbidden

Saturated neon, hard-edged background shapes, thick borders, heavy type, skeuomorphic textures, device
frames with brand shapes, fades without focus change.
