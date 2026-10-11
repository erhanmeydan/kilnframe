# izometrik

Tidy miniature worlds in true isometric projection. Simple blocks and cylinders on floating tiles, every face
one flat tone, calm off-white space around them. Feels like a precise architectural model. Reference stills:
`stills/a-metafor.png`, `stills/b-veri.png`, `stills/c-surec.png`.

## Look

- Off-white background, sage tiles and bars, slate for stands, bases, icons and numbers, terracotta as the
  single accent (paths, signals, the highlighted bar), warm light tone for paper, frames and screens.
- Orthographic camera at the true isometric angle. The angle never changes. No perspective, no depth of field.
- Flat shading per face: top lightest, left mid, right darkest. No textures, no reflections. Very soft, faint
  contact shadows. Edges crisp with a tiny bevel.
- Everything snaps to a grid. Paths turn at right angles along the grid.
- Content sits on the right two thirds, the left third stays calm for the headline.

## Type

- Headlines are flat Outfit Bold on screen, left aligned, not part of the 3D world.
- Numbers inside the world are extruded Outfit ExtraBold letters that lie exactly in an isometric plane
  (standing on the tile or lying flat on it). Never a free perspective angle.
- No dashes in on-screen text.

## Motion

- Objects rise out of the tile or drop onto it and snap to the grid with a small overshoot.
- Bars extrude upward, paths extend segment by segment like a train track being laid.
- Camera only pans and zooms along the grid, it never rotates.
- Transition: pan along the grid to the next tile, or the tile flips down and the next one rises.

## How each technique looks in this style

| Technique    | Look                                                                                  |
| ------------ | ------------------------------------------------------------------------------------- |
| three-3d     | Objects built from boxes and cylinders on a floating tile, as in the stills           |
| data-viz     | Extruded bars on a slate base, accent bar terracotta, extruded number standing behind |
| diagram      | Square platforms joined by terracotta grid paths, one object per platform             |
| ui-mockup    | An isometric screen or phone block on a tile, flat UI blocks on its face              |
| code         | A screen block whose face shows short monospace lines                                 |
| particles    | Small cubes moving along grid paths, seeded                                           |
| kinetic-type | Flat Outfit words on screen, the key word can extrude into an isometric plane         |
| motion-2d    | Flat shapes laid on the isometric planes                                              |
| svg-draw     | Lines drawn along the isometric axes on the tile surface                              |
| canvas-draw  | Not supported                                                                         |

## User images

Images become surfaces in the isometric world: mapped onto a 30 degree panel, a billboard or a screen face of
a block (CSS 3D transform matching the isometric angle, or a Three.js plane texture), lit flatly like the
rest. Screenshots sit on the screen of an isometric device or monitor. Logos sit on a small isometric sign,
never skewed beyond the panel's own angle.

## Sound palette

Soft wooden click when objects snap to the grid, low thud for tiles, short rising tick for extrusions, light
whoosh for camera pans.

## Forbidden

Perspective camera, camera rotation, textures, gradients, glossy materials, realistic objects, free-angle
text, objects off the grid, fade-in entrances.
