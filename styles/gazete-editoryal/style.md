# gazete-editoryal

A quality broadsheet feature page: warm newsprint, thin column rules and framed panels, a heavy serif for
headlines and numbers, drawings made only of clean outlines and straight parallel hatching, and one muted
brick red accent. Considered, calm and authoritative. Reference stills: `stills/a-metafor.png`,
`stills/b-veri.png`, `stills/c-surec.png`.

## Look

- Newsprint background (#E4DBCA) with a very faint seeded speckle grain. Ink (#1F1E1C) for everything; brick
  red (#984330) for one element per scene at most.
- Drawings are outlines plus straight parallel hatching at 45 degrees (or horizontal bands for curved
  surfaces, as on the microphone in A). Never crosshatching, never gradients, never fine engraving texture.
  Keep each object to a few simple shapes.
- Page structure is the identity: a thin vertical column rule at the left third, framed panels with an ink
  border, hairline baselines and small tick marks. Every scene shows at least one rule or frame.
- Leave the left third as plain newsprint for the headline, separated by the column rule.

## Type

- Playfair Display (heavy, 800) for headlines and big numbers, tight leading, as the "73%" in `b-veri`.
  Numbers always use lining figures (`font-variant-numeric: lining-nums`); the font's default old-style
  figures drop below the baseline.
- Source Serif 4 for kickers (small caps, letter-spaced), captions and labels.
- Headlines in sentence case. A headline never crosses the column rule: size it so the longest word fits
  the column (Turkish words run long; 80px fits about 13 letters in the left third at 1080p).
- No dashes in on-screen text.

## Motion

- Order of drawing: rules first along their length, then frames, then contents.
- Hatching sweeps in line by line along its direction. Outlines draw on, then hatching fills.
- Headline words are set in one at a time with a short upward slide inside a mask. Numbers count up.
- Camera: slow pushes and vertical pans, like reading down a page. Transition: a column rule wipes across
  and reveals the next layout. No fades, no bounces, no rotation.

## How each technique looks in this style

| Technique    | Look                                                                                    |
| ------------ | --------------------------------------------------------------------------------------- |
| kinetic-type | Heavy serif headline set word by word, a kicker above in small caps, a rule under it    |
| data-viz     | Framed chart, hatched ink bars, the key bar in solid brick red, huge serif number above |
| diagram      | Framed panels in a row like an explainer strip, slim ink arrows, one red marker dot     |
| svg-draw     | Outline plus hatching drawings drawing on, as in A                                      |
| motion-2d    | Framed panels and rules sliding along the column grid                                   |
| ui-mockup    | The interface as a boxed newspaper graphic: outlined frame, hatched areas, serif labels |
| code         | Source Serif captions with the code set in a framed box in IBM Plex Mono, ink on paper  |
| three-3d     | Not supported: no shaded 3D; use flat outline and hatch drawings instead                |
| particles    | Not supported: the page is still and printed                                            |
| canvas-draw  | Not supported: lines are precise, not hand drawn                                        |

## User images

Photos become newsprint: grayscale, slightly raised contrast, a coarse halftone or line screen overlay
in ink, set in a framed panel with a thin border and a short caption in Source Serif under it. Screenshots
sit in a framed panel like a boxed graphic; the discussed line gets a brick red underline drawn on its word.
Logos stay untouched, placed with clear space inside a frame.

## Sound palette

Soft paper turn for transitions, a quiet press thump when a headline lands, a fine pen scratch while
drawings and hatching draw on, a small type click for numbers and labels.

## Forbidden

Gradients, glow, drop shadows, crosshatching, photographs or photo textures, more than one red element in a
scene, colors other than ink, newsprint and brick red, sans serif headlines, fades, bounces.
