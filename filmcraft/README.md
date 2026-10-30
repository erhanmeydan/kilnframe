# Kilnframe for FilmCraft

[FilmCraft](https://github.com/storytold/filmcraft) has no plugin system, but it can be driven from outside
through its control channel (`--control <port>` with `FILMCRAFT_CONTROL_TOKEN`, see FilmCraft's
`docs/control-protocol.md`). This host reuses the DaVinci Resolve panel unchanged: the page, preload and
`host-resolve` are the same, only the Electron main process talks to FilmCraft instead of Resolve.

- `packages/panel/src/filmcraft/client.ts`: JSON-lines client for the control channel.
- `packages/panel/src/filmcraft/bridge.ts`: the `ResolveBridge` on top of FilmCraft engine commands
  (`sequence.inspect`, `file.exportMedia`, `file.import`, `sequence.addTracks`, `timeline.place`…).
- `packages/panel/src/filmcraft/main.ts`: Electron main, built from `src/resolve/main.ts`.
- `filmcraft/launch.sh`: starts the Kilnframe app, FilmCraft with a fresh control token, and the panel window.
- `filmcraft/make-app.sh`: makes `~/Applications/FilmCraft + Kilnframe.app`, a Dock launcher for `launch.sh`.

Tested on macOS (Apple silicon) with FilmCraft 0.14.0.

## Setup

You need FilmCraft in `/Applications`, the Kilnframe app installed (the companion that plans and renders),
Node 22 and pnpm.

```sh
corepack pnpm install
node packages/app/node_modules/electron/install.js
corepack pnpm --filter @kilnframe/panel build:filmcraft
filmcraft/make-app.sh
```

Open **FilmCraft + Kilnframe** instead of FilmCraft. FilmCraft opened the normal way has no control channel,
so the panel cannot reach it; close it first.

## How it works

- The launcher writes the port and a new 64-hex token to `~/.kilnframe/filmcraft.json` (mode 0600) on every
  start; the token reaches FilmCraft only through its environment.
- Ranges are exported with `file.exportMedia` (wav for speech, h264 at half size for the picture),
  results are imported into a `Kilnframe` bin and placed on new tracks with `timeline.place`; a clip that
  does not land is cleared again.
- FilmCraft time is 254016000000 ticks per second.
