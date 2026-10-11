# Pipeline fixture: kil-iki-sahne

A fixed `plan.json` and two scene sub-compositions (copies of `examples/techniques/three-3d/kil-surec`) to test the
back half of the pipeline without an LLM:

```bash
pnpm --filter @kilnframe/core build
node packages/core/dist/cli.js render --plan examples/pipeline/kil-iki-sahne/plan.json \
  --scenes examples/pipeline/kil-iki-sahne/scenes --out out/kil-iki-sahne
```
