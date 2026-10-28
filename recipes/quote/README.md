# quote

One strong sentence set big in 1 to 4 lines, each line landing on its spoken word, one word or phrase in the accent colour.

Technique: `kinetic-type`. Preview: `node scripts/recipe-preview.mjs quote <style>` renders `sample.json` in every format and mode.

## Renders

On an Apple silicon Mac with GPU. "Passes" means hyperframes check, the overlay haze check and the empty scene check all pass.

| Style           | Format    | Mode       | Checks | Render |
| --------------- | --------- | ---------- | ------ | ------ |
| flat-infografik | landscape | fullscreen | passes | 9.7 s  |
| flat-infografik | landscape | overlay    | passes | 11.8 s |
| flat-infografik | portrait  | fullscreen | passes | 10.6 s |
| flat-infografik | portrait  | overlay    | passes | 14.3 s |
| flat-infografik | square    | fullscreen | passes | 9.5 s  |
| flat-infografik | square    | overlay    | passes | 10.9 s |
