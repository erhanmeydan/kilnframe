# Golden scenes

Finished Kilnframe compositions kept to catch render changes when a dependency is updated
(`pnpm deps:try <id>`). Each folder: `plan.json`, `scenes/`, `assets/` when the scenes use images,
`golden.json` (frame times, measured noise, threshold) and `ref/` (reference frames from the current pinned
versions).

Add one: `node scripts/golden-add.mjs <finished-job-dir> <name>`, then `node scripts/golden-add.mjs --refs <name>`.
Refresh the references after an update that changes renders on purpose: `--refs` again.
