# Companion protocol (v1)

The companion is a local Node service. The Premiere panel talks to it over a WebSocket. This page is the
contract between `packages/panel` (M4) and `packages/companion`.

## Connection

- The companion listens on `127.0.0.1` only (default port 47615, `KILNFRAME_PORT` overrides).
- On start it writes `~/.kilnframe/companion.json` (mode 0600) with `{ port, token, pid, version }`
  and removes it on exit. `KILNFRAME_HOME` moves the folder.
- The first message must be `{ "type": "hello", "token": "<token>" }` within 5 seconds. Anything else, a
  wrong token or a non-loopback peer closes the socket with code 1008.
- After `hello` the server answers `{ "type": "ready", "protocol": 1, "version": "..." }`.

## Client messages

| type                 | fields                                  | answer                                                                                                                                                                                                                                              |
| -------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`             |                                         | `status` with every job's `id`, `state`, `position`, `style`, `createdAt`                                                                                                                                                                           |
| `system.check`       |                                         | `system` with `report: { gpu: { mode, renderer }, ffmpeg, speechModel: { name, cached }, platform }`                                                                                                                                                |
| `models.list`        | `provider`, optional `baseURL`          | `models` with `{ id, displayName, contextWindow, vision, catalog }`; `catalog` holds label, quality tier and price when known                                                                                                                       |
| `providers.list`     | none                                    | `providers` with every preset from providers.json (`id`, `displayName`, `models`, `tier`, `needsKey`, `keySet`, `requires`, `baseURL`, `regions`, `perModelVision`, `keyUrl`) and `claudeCode` (`installed`, `loggedIn`, `version`, `subscription`) |
| `providers.test`     | `provider`, optional `model`, `baseURL` | `providers.tested` with `result` `{ ok, vision, model, ms, message? }`: one short request with a 64x64 red square; `vision` is true when the model named the colour                                                                                 |
| `review.load`        | `outDir`                                | `review` with `review` `{ stillImages, plan: { width, height } }` read from the job folder, or null when it has no stills yet; lets a long range's review outlive the panel and the companion                                                       |
| `models.prepare`     |                                         | broadcast `models.progress` (`message`, 5 percent steps) then `models.ready`                                                                                                                                                                        |
| `job.start`          | `params` (below), optional `ref`        | `job.accepted` (`jobId`, `ref`); broadcast `job.queued`, then `job.progress`*, then `job.done` or `job.error`                                                                                                                                       |
| `job.prepare`        | `sequenceName`, optional `projectPath`  | `job.prepared` with `jobDir`: `<project folder>/Kilnframe/<sequence>-<time>` (or `~/.kilnframe/jobs/...`)                                                                                                                                           |
| `styles.list`        |                                         | `styles` with `{ name, displayName, description, summary, thumb }` (`thumb` is a JPEG data URL)                                                                                                                                                     |
| `job.get`            | `jobId`                                 | the stored `job.done`, `job.error` or `job.cancelled` again, or `job.state` (`queued`, `running`, `unknown`); for a panel that missed the broadcast                                                                                                 |
| `job.cancel`         | `jobId`                                 | `job.cancelled` for a queued or running job (every job runs in its own process; a running one is ended with everything it started), or `error` once it finished                                                                                     |
| `keys.set`           | `provider`, `key`                       | `keys.saved`                                                                                                                                                                                                                                        |
| `keys.has`           | `provider`                              | `keys.has` with `present`                                                                                                                                                                                                                           |
| `keys.delete`        | `provider`                              | `keys.deleted`                                                                                                                                                                                                                                      |
| `app.update.install` |                                         | starts the app's update: broadcast `app.update` (downloading, ready), then the app quits and reopens on the new version; `app.update.busy` while a job is queued or running; `error` when the companion runs without the app                        |
| `speech.stop`        |                                         | stops the voice sample that plays; broadcast `speech.ended`                                                                                                                                                                                         |

`job.start` params:

```json
{
  "audioPath": "/abs/sequence-audio.wav",
  "rangeStartS": 12.5,
  "rangeEndS": 42.0,
  "outDir": "/abs/project/kilnframe/job-1",
  "style": "kil-lacivert",
  "mode": "fullscreen | overlay | auto",
  "frames": [{ "path": "/abs/job/footage-1.png", "atS": 1.6 }],
  "format": "landscape",
  "fps": "30000/1001",
  "sequenceSize": "1920x1080",
  "language": "tr",
  "note": "optional editor note",
  "stillsOnly": false,
  "provider": "auto | claude-code | anthropic | openai-compatible",
  "model": "optional override",
  "baseURL": "optional, for openai-compatible",
  "action": "run (default) | render | recompose",
  "sceneId": "s3, for recompose"
}
```

`action`: `run` runs the pipeline (with `stillsOnly` it stops after one still per scene, for the panel's
review); `render` renders the job folder in `outDir` as it is, without model calls; `recompose` writes
`sceneId` again with `note` as the editor's request, checks the whole project and renders fresh stills.
The panel sends the first job's params again with the action.

`mode: "auto"` lets the plan step choose fullscreen or overlay per scene; the insert renders with alpha
(ProRes 4444) as soon as one scene is an overlay. `frames` (optional, up to 6) are frames of the footage
under the range, `atS` in seconds from the range start: the plan step looks at them to find where the
speaker sits, overlay scenes are composed beside the speaker, and overlay stills are shown over them.
Missing frame files are skipped.

`rangeStartS`/`rangeEndS` cut the in/out range out of a whole-sequence audio export (omit them when `audioPath` is already the range). `format` defaults to the sequence's own format. `job.done.result` contains `outDir`, `plan`, `output` (the insert video
with handles, `null` for stills only), `preview` (insert plus speech and effects), `sfxMix`, `stills`,
`stillImages` (`sceneId`, `image` as a JPEG data URL), `handlesSeconds`, `durationSeconds`, and for model
runs `usage` and `repairRounds`. The panel trims the imported clip to
`[handlesSeconds, handlesSeconds + durationSeconds]` so the handles stay available for trimming.

`system.check` also reports `wavPreset`: Premiere's own 48 kHz WAV export preset, found in the installed
Premiere versions.

## App updates

Inside Kilnframe Helper (packages/app) the companion runs with an IPC channel to the app. The app checks GitHub
Releases with electron-updater at start and every six hours and sends its state, which the companion
broadcasts as `app.update` with `update` `{ status, current, version?, notes?, percent?, error? }`
(`status`: checking, none, available, downloading, ready, error) and sends to every panel right after
`ready`. Nothing downloads or installs until a panel sends `app.update.install`. The companion run on its
own (development, the CLI) sends no `app.update`.

`hello` may carry the panel's `protocol`; the panel compares it with `ready.protocol` and, when they differ,
says which side to update (the app, or the plugin through the app's menu).

## Rules

- One job renders at a time; others wait in order.
- API keys live in the OS keychain (macOS Keychain, Windows Credential Manager, service `kilnframe`,
  account = provider name). They are never written to files, logs or error messages; a failed `keys.set`
  reports only the error class.
- Server events are broadcast to every authenticated client, so a reconnecting panel sees running jobs.
