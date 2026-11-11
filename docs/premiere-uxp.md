# Premiere UXP notes (M4 preparation)

Checked on 2026-10-06 against `@adobe/premierepro@26.5.0` type definitions (no relevant change in
`27.0.0-beta.57`), the AdobeDocs sample `uxp-premiere-pro-samples/sample-panels/premiere-api`, and the
developer.adobe.com reference. Verified inside Premiere Pro 26.5.2 on 7 October 2026 with the probe panel in
`packages/panel` (results below).

General pattern: `const ppro = require("premierepro")`. Getters are async. Every edit is an `Action` added
inside `project.executeTransaction(cb, undoLabel)`, wrapped in `project.lockedAccess(...)`. Minimum version
for the APIs below is 25.6 unless noted.

| Need                     | API                                                                                                                                                                                                  | Status                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Active project, sequence | `ppro.Project.getActiveProject()`, `project.getActiveSequence()`                                                                                                                                     | documented                         |
| In/out                   | `seq.getInPoint()`, `seq.getOutPoint()` → `TickTime` (`.seconds`, `.ticks`)                                                                                                                          | value when unset is undocumented   |
| Work area                | `ppro.WorkAreaUtils.getWorkAreaInPoint(seq)` / `getWorkAreaOutPoint` / `setWorkAreaInOutPoints` (sync)                                                                                               | min version unverified             |
| Frame rate               | `(await seq.getSettings()).getVideoFrameRate()` → `.ticksPerFrame`; exact rational = `TickTime.TIME_ONE_SECOND.ticksNumber / ticksPerFrame`, reduced by GCD (254016000000 / 8475667200 = 30000/1001) | compute at runtime                 |
| Frame size, PAR          | `getVideoFrameRect()`, `getVideoPixelAspectRatio()`                                                                                                                                                  | documented                         |
| Audio of the range       | `EncoderManager.getManager().exportSequence(seq, ExportType.IMMEDIATELY, path, presetEpr, exportFull)`; `exportFull=false` means work area per docs                                                  | needs our own WAV `.epr` preset    |
| Still frames             | `ppro.Exporter.exportSequenceFrame(seq, tickTime, name, dir, w, h)`                                                                                                                                  | documented                         |
| Import                   | `project.importFiles(paths, true, bin, false)` → boolean; find items via `findItemsMatchingMediaPath`                                                                                                | documented                         |
| Place on tracks          | `ppro.SequenceEditor.getEditor(seq).createOverwriteItemAction(item, time, vIdx, aIdx)`; indices 0-based; insert creates tracks past the count                                                        | skipping one track type unverified |
| Premiere transcript      | `ppro.Transcript` is per clip only (`exportToJSON`, `hasTranscript` 26.3+); no sequence transcript, caption text not readable                                                                        | keep Whisper                       |

## Decisions this suggests

1. **Range audio:** export the whole sequence audio as WAV (or the work area set to in/out) and let the
   companion cut `[in, out]` with FFmpeg. This does not depend on undocumented export modes.
2. **Frame rate:** always compute the rational from ticks; never round `FrameRate.value`.
3. **Transcript:** Whisper stays the source; Premiere's clip transcript can be an optional extra later.
4. **Minimum Premiere:** 25.6.0 (the sample manifest says 25.1.0 but the APIs need 25.6).

## Manifest (v5)

```json
{
  "manifestVersion": 5,
  "host": { "app": "premierepro", "minVersion": "25.6.0" },
  "requiredPermissions": {
    "localFileSystem": "fullAccess",
    "network": { "domains": ["ws://localhost", "ws://127.0.0.1"] }
  }
}
```

UXP is a WebSocket client only (fits the companion design). The exact domain syntax for plain `ws://` on
localhost is undocumented; a community fix used `ws://localhost/`. Fallback: `"all"`. Reading
`~/.kilnframe/companion.json` needs `fullAccess` and `require("os").homedir()`.

## Build and load

Adobe's sample uses TypeScript + Vite (CommonJS output, `premierepro`, `uxp`, `os` external, `public/` holds
`manifest.json` and `index.html`). Load `dist/manifest.json` in UXP Developer Tool 2.2+ after enabling
Settings > Plugins > developer mode in Premiere.

## Open items to test in Premiere

1. What `getInPoint`/`getOutPoint` return with no in/out set.
2. The string returned by `seq.getTimebase()`.
3. Whether `exportSequence(..., exportFull=false)` uses in/out or only the work area.
4. Whether `encodeProjectItem` mode 1 means in/out (sample comment only; needs Media Encoder).
5. Shipping a WAV `.epr` preset with the plugin.
6. Overwrite placing past the track count, and how to place video only or audio only.
7. Manifest syntax for `ws://localhost`.
8. Minimum version of `WorkAreaUtils`.

## Results in Premiere Pro 26.5.2 (macOS, 7 October 2026)

Run with the probe panel on a sequence made from `hinton.mp4` (1920x1080), loaded through UXP Developer Tool.
The panel now also writes its log to `~/.kilnframe/probe/log.txt`.

| Test                    | Result                                                                                                                                                                                                                                                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In/out unset            | `getInPoint`/`getOutPoint` return `-400000` s (ticks `-101606400000000000`) instead of failing. Treat a negative value as "no in/out".                                                                                                                                                                               |
| In/out set              | Frame accurate: in 4.9598 s / out 15.0460 s with exact ticks.                                                                                                                                                                                                                                                        |
| Frame rate              | `254016000000/10587056659` (23.993 fps). The file says 24000/1001 but is variable frame rate (average 23.968); Premiere built the sequence at its own measured rate. Real footage gives non-standard rates, so the pipeline must accept any rational.                                                                |
| Timebase                | `getTimebase()` returns the ticks per frame as a string (`"10587056659"`).                                                                                                                                                                                                                                           |
| Frame size, PAR, tracks | 1920x1080, `1:1`, 3 video and 3 audio tracks.                                                                                                                                                                                                                                                                        |
| Still frame             | `Exporter.exportSequenceFrame` wrote a 1920x1080 PNG identical to the source frame at the in point.                                                                                                                                                                                                                  |
| Sequence audio          | `exportSequence(..., IMMEDIATELY, path, preset, true)` wrote the whole sequence as 48 kHz stereo 16-bit WAV (40.09 s). Premiere ships the preset: `Contents/MediaIO/systempresets/3F3F3F3F_57415645/Waveform Audio 48kHz 16-bit.epr` inside the app bundle, so we do not need our own `.epr`.                        |
| Companion               | `ws://localhost` connects and `system.check` answers (hardware GPU, FFmpeg, cached Whisper). `ws://127.0.0.1` is refused: "Permission denied ... Manifest entry not found" even though it is listed, so IP entries do not work; use `ws://localhost`. Reading `~/.kilnframe/companion.json` works with `fullAccess`. |
| Import                  | `importFiles([path], true, bin, false)` works. Items returned by `getItems()` are plain ProjectItems: a bin must go through `ppro.FolderItem.cast()` before `getItems()`.                                                                                                                                            |
| Place                   | `createOverwriteItemAction(item, time, 3, 3)` on a sequence with 3 video tracks placed the insert on a new 4th video track at the in point, as one undoable step.                                                                                                                                                    |

| Track contents | `track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)` returns a track's clips synchronously; an empty array means an empty track. The panel places inserts on the first empty track above the highest used one (`freeTracks` in `premiere.ts`). |
| Frame size | `SequenceSettings.setVideoFrameRect(rect)` with `new ppro.RectF()` (width, height) changes a new sequence's frame before `createSetSettingsAction`; story mode uses it for 16:9, 9:16 and 1:1. |
| Range picture | `WorkAreaUtils.setWorkAreaInOutPoints` to the range, then `exportSequence(seq, IMMEDIATELY, path, preset, false)` with Premiere's own `4E49434B_48323634/02 - Match Source - Low bitrate.epr` wrote only the range (10.84 s, 1920x1080, 25 fps, 5.7 MB) in under a second; the work area was put back unchanged (9 Oct 2026). So `exportFull=false` follows the work area. |
| First click | With another app in front, the first click on the panel only activates Premiere: the panel gets a document `focus` event and no pointer events; pointer moves do not arrive while Premiere is in the background either. The click cannot be recovered, so the panel dims its buttons while a click could be lost (`asleep` class in `app.ts`) and the guide tells the editor to click again. |

| Layout | Every box is laid out as a flex item: a 100% high scroll area squeezed a bar below it to 19 px, and `flex-shrink: 0`, an absolute bar with a height, `aspect-ratio`, `::placeholder` and `opacity` on buttons had no effect. The panel sizes its scroll area in code above a fixed-height bar (`fitScroll` in `app.ts`) and gives the bar's children fixed heights. |

## Cutting a copy of a sequence (probe button 7, Premiere 26.5, 25 fps, 11 November 2026)

Measured on a clone, never on the editor's sequence. Public actions only.

| Question                                                                             | Answer                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Copy a sequence                                                                      | `executeTransaction(c => c.addAction(sequence.createCloneAction()))` makes the copy; it is the sequence whose guid was not in `project.getSequences()` before. `(await clone.getProjectItem()).createSetNameAction(name)` renames it. The copy holds every clip with the same in and out points. |
| `createSetStartAction(t)`                                                            | A trim: start 0 → 1 moved the in point 64.28 → 65.28; the end stayed.                                                                                                                                                                                                                            |
| Linked audio                                                                         | Trimming the video clip left its audio clip unchanged: every clip is edited on its own.                                                                                                                                                                                                          |
| `createSetEndAction(t)`                                                              | Shrinks (5.04 → 4.04, out point follows) and grows back into free space (→ 4.54).                                                                                                                                                                                                                |
| `SequenceEditor.createCloneTrackItemAction(item, offset, 0, 0, alignToVideo, false)` | The copy lands at the item's start plus `offset`, on the same track, snapped to the frame (0.25 s → 1.24 at 25 fps), same in point, same length, and overwrites what lies under it (the original was cut to 1.00 to 1.24). With `alignToVideo` true an audio clip lands the same way.            |
| `createMoveAction(t)`                                                                | A shift, not a position: `T(2)` moved a clip starting at 1 to 3. A move does not overwrite: two clips can end up over each other, so clips only move into space that is already empty.                                                                                                           |
| Many actions                                                                         | 300 actions in one transaction took 5 ms and are one undo step.                                                                                                                                                                                                                                  |
| Razor, extract, lift                                                                 | `createRazorAllTracksAction`, `createRazorTrackAction`, `createExtractActionInRange`, `createLiftActionInRange` are `undefined` on `SequenceEditor` in a plugin.                                                                                                                                 |
| Objects after a transaction                                                          | Track items, the sequence and its `SequenceEditor` read before a transaction may be "no longer valid" after it (a long linked clip trimmed in one step could not be copied in the next). Read them again before each step.                                                                       |
| Where actions are made                                                               | An action made before `executeTransaction` and added inside it was refused as "no longer valid" (piece copies, marker moves, In/Out). Make every action inside the transaction callback.                                                                                                         |
| Copying a linked audio clip                                                          | With `alignToVideo` true, a copy of an audio clip linked to video was refused ("Illegal Parameter type"); with false it was taken. A lone audio clip takes true.                                                                                                                                 |

Still open: the oldest Premiere version that has these APIs, and
Windows.
