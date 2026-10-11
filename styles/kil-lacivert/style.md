# kil-lacivert

Matte handmade clay objects in a deep navy studio, lit by one warm amber key light. Everything looks like
plasticine: soft rounded edges, subtle fingerprints and bumps, no gloss. Calm, tactile, slightly playful.
Reference stills: `stills/a-metafor.png`, `stills/b-veri.png`, `stills/c-surec.png`.

## Look

- Navy backdrop and navy clay floor with a visible horizon. Edges fall off to darker navy, warm amber glow
  in the upper right where the key light comes from.
- Objects are cream, amber or mustard clay. Never more than these plus navy. Red only for a call to action,
  green only for a confirmation.
- Clay surface texture is generated in code: a seeded procedural normal map with fingerprint swirls and soft
  bumps. No image textures.
- Soft contact shadows, light depth of field, fine film grain, soft vignette.
- Keep the left third calm for the headline.

## Type

- Headlines: Barlow Condensed ExtraBold, upper case, cream, one line per scene at most. No dashes in on-screen
  text.
- Numbers and short words that live inside the 3D world are extruded clay letters in Baloo 2 ExtraBold, with
  rounded bevels and the same clay surface.

## Motion

- Objects drop in and settle with one squash bounce. Nothing fades in.
- Camera pushes or orbits slowly, never shakes.
- Accent moments: a short burst of amber clay strokes around the object that just landed.
- Transitions: an object or screen grows to fill the frame, then the next scene starts inside it.

## How each technique looks in this style

| Technique    | Look                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------ |
| three-3d     | Clay objects on the navy floor, as in the stills                                                 |
| kinetic-type | Barlow headline words rise in with stagger; key word can drop as clay letters                    |
| data-viz     | Bars are rounded clay blocks dropping in order, highlight bar amber, number counts up in clay    |
| diagram      | Clay tokens in a row joined by thick rounded amber clay arrows that grow                         |
| ui-mockup    | A cream clay device or card with simple clay UI shapes, no real screenshots unless user provides |
| code         | Code on a cream clay card, monospace, short lines only                                           |
| particles    | Small clay pebbles or crumbs, seeded                                                             |
| svg-draw     | Rendered as clay strings or extruded strokes, not flat lines                                     |
| canvas-draw  | Not supported, plan step must not choose it                                                      |

## User images

Images sit inside the clay world: a clay frame or clay screen modelled in Three.js holds the image as a
texture, under the warm key light with the grain. Photos are toned slightly toward the navy shadows.
Screenshots appear on the screen of a clay device. Logos sit on a clay plaque with their colours kept.

## Sound palette

Clay thock on every landing, paper, soft whoosh for camera moves, pop, tick, shimmer, chime, quiet room tone.
Effects sit about 20 LU under speech.

## Forbidden

Gloss, metal, glass, realistic faces, real logos, gradient backgrounds other than the navy falloff, centered
headlines, fade-in entrances, camera shake.
