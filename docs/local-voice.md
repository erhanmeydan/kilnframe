# Local voice (OpenAI-compatible)

Story mode and Voice Fix can read with a speech server on your own computer or network instead of
ElevenLabs or Gemini. Nothing is sent to a cloud service, no key is needed and there is no charge.

Kilnframe does not ship a speech model. It talks to any server that answers OpenAI's text to speech
request, so you can put a local model (Kokoro, Piper, XTTS, VoxCPM, ...) behind a small HTTP server of
your own and point Kilnframe at it.

## Set it up

1. Start the server. Kilnframe expects `http://127.0.0.1:8890` unless you say otherwise.
2. Settings, Narration and Music, "Local voice (OpenAI-compatible)": type the server's address
   (without `/v1`). Leave it empty for the default. The command-line tool reads `LOCAL_BASE_URL`.
3. Story mode: pick **Local voice** next to Gemini and ElevenLabs. Voice Fix: pick **Local voice** on its
   first screen (before you press Fix This Part).
4. A bearer token is optional: the command-line tool reads `LOCAL_API_KEY`, the companion reads a key saved
   under the name `local` in the keychain. Without one, no Authorization header is sent.

```bash
LOCAL_BASE_URL=http://127.0.0.1:8890 \
  kilnframe story --script talk.txt --out out --speech-provider local --speech-model tts-1 --voice alloy
```

## What the server has to do

| Request                                                    | Needed | Notes                                                                                                                                                                                                                               |
| ---------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/audio/speech`                                    | yes    | JSON `{ model, input, voice, response_format: "wav", instructions? }`. Answer a mono 16-bit WAV (any sample rate; it is resampled to 48 kHz).                                                                                       |
| `GET /v1/audio/voices`                                     | no     | `{ "data": [{ "id": "anna" }] }` or `{ "voices": [{ "name": "anna" }] }`. Without it the panel offers one voice, `default`, which is also what is sent when no voice was chosen for this provider; most servers accept `alloy` too. |
| `POST /v1/audio/voices` (multipart `name`, `audio_sample`) | no     | Makes a voice from a recording and answers `{ "id": "..." }`. Used by "Clone a Voice" and by Voice Fix. Without it, cloning says the server cannot.                                                                                 |

`instructions` carries the delivery direction ("calm and warm") and may be ignored. `response_format`
`"pcm"` (raw 24 kHz mono 16-bit little-endian, as OpenAI defines it) is supported by the provider class too.
Errors are read from OpenAI's `{ "error": { "message": "..." } }`; 429 and 5xx are retried.

The model and voice names are whatever your server knows. The catalog's model `tts-1` is only a
placeholder; the command line takes `--speech-model`.

## Music

Music stays with Lyria and ElevenLabs. A local music provider would need its own entry in
`config/music.json`, a `MusicProvider` in `packages/core/src/music` (text prompt and a length in, a clip
out) and a server that makes music; OpenAI defines no such request, so there is no common shape to follow
yet.
