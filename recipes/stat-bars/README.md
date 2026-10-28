# stat-bars

2 to 5 spoken values as bars on a baseline, each growing on its word, the key value counted up as a giant number.

Technique: `data-viz`. Preview: `node scripts/recipe-preview.mjs stat-bars <style>` renders `sample.json` in every format and mode.

## Renders

On an Apple silicon Mac with GPU. "Passes" means hyperframes check, the overlay haze check and the empty scene check all pass.

| Style           | Format    | Mode       | Checks | Render |
| --------------- | --------- | ---------- | ------ | ------ |
| flat-infografik | landscape | fullscreen | passes | 10.4 s |
| flat-infografik | landscape | overlay    | passes | 11.7 s |
| flat-infografik | portrait  | fullscreen | passes | 13 s   |
| flat-infografik | portrait  | overlay    | passes | 12 s   |
| flat-infografik | square    | fullscreen | passes | 9.2 s  |
| flat-infografik | square    | overlay    | passes | 10.7 s |
