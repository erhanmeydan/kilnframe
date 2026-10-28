# quote

One strong sentence set big in 1 to 4 lines, each line landing on its spoken word, one word or phrase in the accent colour.

Technique: `kinetic-type`. Preview: `node scripts/recipe-preview.mjs quote <style>` renders `sample.json` in every format and mode.

## Renders

On an Apple silicon Mac with GPU. "Passes" means hyperframes check, the overlay haze check and the empty scene check all pass.

| Style           | Format    | Mode       | Checks | Render |
| --------------- | --------- | ---------- | ------ | ------ |
| flat-infografik | landscape | fullscreen | passes | 9.2 s  |
| flat-infografik | landscape | overlay    | passes | 10.7 s |
| flat-infografik | portrait  | fullscreen | passes | 9 s    |
| flat-infografik | portrait  | overlay    | passes | 11.2 s |
| flat-infografik | square    | fullscreen | passes | 8 s    |
| flat-infografik | square    | overlay    | passes | 9.5 s  |
| beyaz-tahta     | landscape | fullscreen | passes | 9.8 s  |
| beyaz-tahta     | landscape | overlay    | passes | 10.6 s |
| beyaz-tahta     | portrait  | fullscreen | passes | 10.1 s |
| beyaz-tahta     | portrait  | overlay    | passes | 11.1 s |
| beyaz-tahta     | square    | fullscreen | passes | 8.2 s  |
| beyaz-tahta     | square    | overlay    | passes | 9.4 s  |
