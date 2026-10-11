# kinetik-tipografi

The words are the picture. Huge, heavy Archivo type in bone white on near black, cropped by the frame, with
one signal orange accent. The spoken words appear exactly when they are said. Reference stills:
`stills/a-metafor.png`, `stills/b-veri.png`, `stills/c-surec.png`.

## Look

- Near black background, bone white type, one orange accent per scene (the stressed word, a symbol, an
  arrow). Very fine uniform grain. Letter edges always clean.
- One font family, Archivo Black, used at different widths: extended (125) for one hero word, condensed (62)
  for the rest. Never more than two widths in a scene.
- Scale contrast is the whole design: the hero word fills or overflows the frame and may be cropped by the
  edges. Tight leading. Left or edge aligned, never centered.
- Simple graphic supports only: a thin line waveform, thick flat arrows with right-angle turns, plain bars.
  They live between and over the letters.
- Words are typeset upright. Diagonal compositions come from placing words as steps, not from slanting
  letters.

## Type

- Upper case. Turkish letters must render with the font's own glyphs (İ with its dot, Ş, Ğ, Ç, Ö, Ü).
- No dashes in on-screen text.

## Motion

- Every word enters on its own transcript timestamp: slides in from a frame edge or rises from behind a mask
  line with a fast expo ease. Hard cuts between word groups on the beat, no crossfades.
- The stressed word stretches from condensed to extended width (animated width axis) and turns orange.
- Numbers count up while the width breathes. Arrows extend from their tail.
- Exit: words leave through the nearest frame edge.

## How each technique looks in this style

| Technique    | Look                                                                        |
| ------------ | --------------------------------------------------------------------------- |
| kinetic-type | The core of the style, as described above                                   |
| data-viz     | One giant number with a minimal bar stack beside it, as in `b-veri`         |
| diagram      | Step words joined by thick orange right-angle arrows, as in `c-surec`       |
| motion-2d    | Plain bars, lines and arrows in bone white or orange, moving with the words |
| svg-draw     | Thin waveform or underline drawn through the letters                        |
| code         | Monospace is not used; code is shown as a single huge keyword instead       |
| ui-mockup    | Not supported                                                               |
| three-3d     | Not supported                                                               |
| particles    | Not supported                                                               |
| canvas-draw  | Not supported                                                               |

## User images

Images are secondary to type: shown in a hard-edged band or block between the words, as a two-colour
duotone (ink and the orange accent), cropped boldly but never cutting the subject. Screenshots appear as a
tight crop of the discussed part, framed by huge type. Logos stay untouched, small, with clear space.

## Sound palette

Short tight hits on each word, a low punch on the hero word, quick swish for slides, a tick per count step.

## Forbidden

Centered text, slanted or italic letters, distressed or worn edges, more than one accent color, more than
two widths per scene, other fonts, images or icons, 3D, fades and crossfades.
