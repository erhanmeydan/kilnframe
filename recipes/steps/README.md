# steps

A process of 3 to 5 steps in order, each node and its label appearing on its word, joined by drawn connectors, one step in the accent.

Technique: `diagram`. Preview: `node scripts/recipe-preview.mjs steps <style>` renders `sample.json` in every format and mode.

## Renders

On an Apple silicon Mac with GPU. "Passes" means hyperframes check, the overlay haze check and the empty scene check all pass.

| Style           | Format    | Mode       | Checks | Render |
| --------------- | --------- | ---------- | ------ | ------ |
| flat-infografik | landscape | fullscreen | passes | 10.2 s |
| flat-infografik | landscape | overlay    | passes | 11.8 s |
| flat-infografik | portrait  | fullscreen | passes | 10.6 s |
| flat-infografik | portrait  | overlay    | passes | 11.8 s |
| flat-infografik | square    | fullscreen | passes | 8.7 s  |
| flat-infografik | square    | overlay    | passes | 10.1 s |
| beyaz-tahta     | landscape | fullscreen | passes | 10.7 s |
| beyaz-tahta     | landscape | overlay    | passes | 12.3 s |
| beyaz-tahta     | portrait  | fullscreen | passes | 10.6 s |
| beyaz-tahta     | portrait  | overlay    | passes | 12.1 s |
| beyaz-tahta     | square    | fullscreen | passes | 8.8 s  |
| beyaz-tahta     | square    | overlay    | passes | 10.4 s |
