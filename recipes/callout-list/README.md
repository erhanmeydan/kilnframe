# callout-list

A short heading and 2 to 4 short points stacking in on their words, each with a marker, one point in the accent.

Technique: `motion-2d`. Preview: `node scripts/recipe-preview.mjs callout-list <style>` renders `sample.json` in every format and mode.

## Renders

On an Apple silicon Mac with GPU. "Passes" means hyperframes check, the overlay haze check and the empty scene check all pass.

| Style           | Format    | Mode    | Checks | Render |
| --------------- | --------- | ------- | ------ | ------ |
| flat-infografik | landscape | overlay | passes | 11.2 s |
| flat-infografik | portrait  | overlay | passes | 11.4 s |
| flat-infografik | square    | overlay | passes | 10 s   |
