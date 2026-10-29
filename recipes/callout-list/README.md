# callout-list

A short heading and 2 to 4 short points stacking in on their words, each with a marker, one point in the accent.

Technique: `motion-2d`. Preview: `node scripts/recipe-preview.mjs callout-list <style>` renders `sample.json` in every format and mode.

## Renders

On an Apple silicon Mac with GPU. "Passes" means hyperframes check, the overlay haze check and the empty scene check all pass.

| Style           | Format    | Mode       | Checks | Render |
| --------------- | --------- | ---------- | ------ | ------ |
| flat-infografik | landscape | fullscreen | passes | 9 s    |
| flat-infografik | landscape | overlay    | passes | 10.9 s |
| flat-infografik | portrait  | fullscreen | passes | 9.3 s  |
| flat-infografik | portrait  | overlay    | passes | 11.1 s |
| flat-infografik | square    | fullscreen | passes | 8.4 s  |
| flat-infografik | square    | overlay    | passes | 10.1 s |
| beyaz-tahta     | landscape | fullscreen | passes | 10.7 s |
| beyaz-tahta     | landscape | overlay    | passes | 11.6 s |
| beyaz-tahta     | portrait  | fullscreen | passes | 10.7 s |
| beyaz-tahta     | portrait  | overlay    | passes | 11.8 s |
| beyaz-tahta     | square    | fullscreen | passes | 8.7 s  |
| beyaz-tahta     | square    | overlay    | passes | 10.3 s |
