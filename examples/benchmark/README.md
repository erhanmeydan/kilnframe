# Benchmark set

A fixed set of clips with different kinds of content. Every model and every new release runs
against it, so we see where generation breaks before users do. The cases and what each one tests are in
[`cases.json`](cases.json).

## Clips

- **Synthetic** clips are spoken by the macOS voices (Yelda for Turkish, Samantha for English) and mixed with
  a music bed built from sine tones and pink noise. They are not committed; generate them on a Mac:

  ```bash
  node scripts/make-benchmark-audio.mjs
  ```

  The files land in `examples/benchmark/audio/` (gitignored).

- **Real** clips are recordings from the maintainer. They stay in `examples/audio/private/` and are never published.

## Transcription results (7 October 2026)

Local Whisper (`whisper-large-v3-turbo_timestamped`, q8) on an M-series Mac. Word error rate against the
source text; numbers written as digits count as errors here even though they are better on screen.

| Case         | Length | Time  | WER   | Notes                                                           |
| ------------ | ------ | ----- | ----- | --------------------------------------------------------------- |
| tr-sayilar   | 18 s   | 4.7 s | 27.8% | all of it digits instead of words ("%62", "120 bin")            |
| tr-surec     | 18 s   | 4.6 s | 6.3%  | "renk" heard as "rent"                                          |
| tr-urun      | 18 s   | 4.8 s | 0%    |                                                                 |
| tr-kod       | 14 s   | 4.2 s | 15.4% | "npm run dev" heard as "npm randev"                             |
| tr-soyut     | 13 s   | 4.1 s | 0%    |                                                                 |
| en-explainer | 12 s   | 3.9 s | 0%    |                                                                 |
| tr-kisa      | 3 s    | 3.2 s | 0%    |                                                                 |
| tr-uzun      | 72 s   | 19 s  | 0.7%  |                                                                 |
| tr-gurultu   | 13 s   | 4.3 s | 8.3%  | under the music bed "rüzgar" heard as "rüzdar"                  |
| sessiz       | 8 s    | 3.3 s |       | Whisper invented "Altyazı M.K."; now stops with a clear message |

The plan prompt already tells the model to correct obvious recognition mistakes in on-screen text, never to
invent words. Whether it does is checked in the plan runs.

## Plan stage (7 October 2026, Claude Code, claude-opus-5-5, kil-lacivert)

One model call per case, no repairs needed. About $0.90 at API prices for the eleven synthetic and reference
cases, $0.63 for the seven real clips; billed to the Claude plan.

Working as intended: recognition mistakes were corrected on screen ("rüzdar" to RÜZGAR, "npm randev" to npm
run dev, "rent" to RENK); English stayed English; the 3 s range got one scene and the 72 s range twelve; the
product talk became four ui-mockup scenes; the music-only clip stopped before any model call.

The first run broke the routing rules: a four-step process came out as five three-3d scenes and one diagram,
two of three code scenes became three-3d, and an idea without numbers got a chart. Three sentences were added
to the plan prompt (the content picks the technique, the style only dresses it; data-viz only with numbers;
commands and code are code). After that:

| Case       | Before                                          | After                                     |
| ---------- | ----------------------------------------------- | ----------------------------------------- |
| tr-surec   | three-3d x5, diagram                            | diagram x6                                |
| tr-kod     | code, three-3d x2                               | code x3                                   |
| tr-soyut   | three-3d, data-viz, kinetic-type, three-3d      | three-3d, diagram, kinetic-type, three-3d |
| tr-sayilar | three-3d, data-viz, three-3d, diagram, data-viz | data-viz x3, motion-2d, data-viz          |

Real clips found two transcription bugs, both fixed: without a language Whisper silently assumed English
(now detected first), and audio over 30 s repeated words at the window seam.

## Full runs on real clips (7 October 2026, Claude Code, claude-opus-5-5, effort high)

Three clips picked for variety, each in a different style; billed to the Claude plan.

| Clip   | Source                           | Style          | Scenes | Time   | Repairs | API price |
| ------ | -------------------------------- | -------------- | ------ | ------ | ------- | --------- |
| sigir  | vertical 720x1280, 25 fps, 30 s  | kolaj-halftone | 6      | 13.9 m | 2       | $8.21     |
| zeki   | audio only, 36 s, archival story | retro-risograf | 6      | 11.6 m | 1       | $6.03     |
| hinton | English, 1080p 23.976 fps, 40 s  | beyaz-tahta    | 7      | 7.9 m  | 0       | $4.42     |

All three rendered and read as their style. Portrait was composed for portrait, not cropped; cards landed on
their words ("peynir" at 28.4 s, "yoğurt" at 29.4 s); English stayed English; the 36 s clip crossed the window
seam cleanly after the fix. The repair reasons of these runs were not kept; from now on every check round is
saved in `checks/round-N.json` and the log names the finding codes per scene.

## Style suggestion (7 October 2026, Claude Code)

`kilnframe suggest --transcript <file>` reads the whole video's transcript and the ten style descriptions
and recommends two or three styles with a reason (one style per video). Run on all seventeen
transcripts with Haiku 4.5, then five of them again with Sonnet 5.5.

| Case       | Haiku 4.5 (first pick) | Sonnet 5.5 (first pick) |
| ---------- | ---------------------- | ----------------------- |
| tr-kod     | kinetik-tipografi      | cam-arayuz              |
| tr-gurultu | cam-arayuz             | beyaz-tahta             |
| tr-sayilar | cam-arayuz             | flat-infografik         |
| zeki       | kagit-kesik            | retro-risograf          |
| sigir      | kagit-kesik            | kagit-kesik             |

Haiku was sensible on most clips (hinton to beyaz-tahta, the app walkthrough to cam-arayuz, the process to
teknik-cizim) but its Turkish reasons had spelling mistakes and English words, and it put a typographic style
first for a code talk. Sonnet's reasons name the content ("120 bin abone, %62 ve %18 gibi rakamlar") in clean
Turkish. About $0.02 per suggestion with Haiku and $0.04 with Sonnet at API prices, so Sonnet is the default
(`text.suggestModel` in `packages/core/config/defaults.json`).

> retro-risograf was removed from the style list on 2026-10-07; rows that use it are earlier measurements.
