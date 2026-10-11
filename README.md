<p align="center"><img src="packages/app/assets/icon.png" width="112" alt="Kilnframe"></p>

<h1 align="center">Kilnframe</h1>

<p align="center">Animated inserts for Premiere Pro, made from what you say.<br>
Select a range, pick a style, and a code-made animation with sound effects lands on your timeline.</p>

<p align="center"><a href="#türkçe">Türkçe</a></p>

---

Kilnframe is a free, open source plugin for Adobe Premiere Pro. You mark an in/out range on the timeline;
Kilnframe listens to the speech in it, plans scenes that fit what is said (a chart for a number, a diagram
for a process, a 3D metaphor for an idea, big type for a strong sentence), writes each scene as an
HTML, CSS and JavaScript animation, renders it on your own computer with
[HyperFrames](https://github.com/heygen-com/hyperframes), and places the video and its sound effects above
the range.

- **Eleven styles and your own.** One style per video keeps every insert consistent. Each style dresses
  every technique in its own look: a bar chart in Navy Clay is made of clay, in Whiteboard it is drawn in pen.
- **Fullscreen or over you.** In Automatic mode each scene decides: something to read comes fullscreen, a
  short accent sits over your footage on the side you are not on.
- **You approve before it renders.** One still per scene; redo a single scene with a note.
- **Sound effects on their own track,** synthesized, nothing to license.
- **Your plan or your key.** Use Claude Code, Codex or Grok with your own subscription, or an API key.
- **Renders locally.** Your audio and video never leave your computer.

## Install

You need Premiere Pro 2026 (25.6 or later) and a computer with a GPU.

|                                    | Download                                                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| macOS, Apple silicon (M1 or later) | [Kilnframe-mac.pkg](https://github.com/erhanmeydan/kilnframe/releases/latest/download/Kilnframe-mac.pkg)         |
| Windows 10 or 11, 64-bit           | [Kilnframe-Windows.exe](https://github.com/erhanmeydan/kilnframe/releases/latest/download/Kilnframe-Windows.exe) |

Intel Macs are not supported yet.

1. Open the installer. It installs the Kilnframe app (a small icon in the menu bar or the system tray) and
   the Premiere plugin in one go.
2. Restart Premiere, then open **Window > UXP Plugins > Kilnframe**.

On Windows, SmartScreen may say it protected your PC, because the installer is not code signed yet. Click
**More info**, then **Run anyway**. The Mac installer is signed and notarized by Apple.

The app starts with your computer and keeps itself up to date: when a new version is out, the panel shows
**Update**. It never updates while an animation is being made. The speech recognition model (about 1 GB) is
downloaded once, with the first animation.

## Connect an AI

Kilnframe writes the animations with a model you choose. Only models that can see images are offered: they
check the stills, match your style and find where you are in the frame.

| Way          | What you need                                             | Who pays                      |
| ------------ | --------------------------------------------------------- | ----------------------------- |
| Claude plan  | [Claude Code](https://claude.com/claude-code), signed in  | your Claude subscription      |
| ChatGPT plan | [Codex](https://github.com/openai/codex), signed in       | your ChatGPT subscription     |
| Grok plan    | [Grok Build](https://x.ai/build), signed in               | your Grok subscription        |
| API key      | Claude, OpenAI, Google Gemini, xAI, MiniMax or OpenRouter | per use, on that account      |
| Local        | a vision model in [LM Studio](https://lmstudio.ai)        | free, slower, simpler results |

The plans work through the terminal programs, not the desktop apps: the Claude, ChatGPT or Grok app alone is
not enough. Claude Code needs a paid Claude plan. Install one with its vendor's command, then type `claude`,
`codex` or `grok` once and sign in in the browser:

| Program     | macOS (Terminal)                                        | Windows (PowerShell)                                                                       |
| ----------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Claude Code | `curl -fsSL https://claude.ai/install.sh \| bash`       | `irm https://claude.ai/install.ps1 \| iex`                                                 |
| Codex       | `curl -fsSL https://chatgpt.com/codex/install.sh \| sh` | `powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 \| iex"` |
| Grok Build  | `curl -fsSL https://x.ai/cli/install.sh \| bash`        | `irm https://x.ai/cli/install.ps1 \| iex`                                                  |

Open the panel's settings (⚙) to choose. Keys are stored in your system's keychain (macOS Keychain,
Windows Credential Manager), never in a file. Claude and GPT models are marked Recommended; the others work.

## Your first animation

1. Mark an in/out range on the timeline (10 to 40 seconds works best).
2. Pick a style for the video.
3. Press **Create Animation**. Scenes are planned and written; this takes a few minutes.
4. Look at the stills. Redo any scene with a note, then press **Approve and Render**.
5. The animation lands on the first free video track above your footage, the sound effects on their own
   audio track, both with handles so you can trim.

A step-by-step guide with screenshots: [docs/ilk-animasyon.md](docs/ilk-animasyon.md) (Turkish for now).

## Styles

| Style               | Look                                                                         |
| ------------------- | ---------------------------------------------------------------------------- |
| Navy Clay           | Matte clay objects in a navy studio, one warm light and a light grain        |
| Flat Infographic    | Clear information graphics made of flat color fields and geometric shapes    |
| Isometric           | Miniature blocks at an isometric angle, flat toned surfaces, paths on a grid |
| Kinetic Typography  | The type is the picture: big, tight letters that run off the frame           |
| Whiteboard          | Simple drawings made step by step in black pen on paper, one red accent      |
| Paper Cut           | Layer on layer of cut paper, real paper texture and soft shadows             |
| Halftone Collage    | Torn paper collage, large halftone dots, tape and cut-out letters            |
| Retro Risograph     | Three-ink risograph print, shifted layers and coarse grain                   |
| Glass Interface     | Frosted glass panels on a dark background, a clean interface language        |
| Technical Drawing   | Thin technical drawings on blueprint, dimension lines and an amber signal    |
| Editorial Newspaper | Newsprint, column rules, serif headlines and line-hatched drawings           |
| Your Own Style      | Describe it in words or show a reference image                               |

Colors are kept muted so they sit well next to graded, low-contrast footage. Adding a style needs no code:
see [styles/](styles/).

## What leaves your computer

Only text and a few small stills go to the AI you chose: the transcript, the scene plan, the style's
description and, for Automatic mode, three frames of the range so the model can see where you stand.
Your audio and video files stay on your computer. Rendering, speech recognition and sound effects run
locally.

## Contributing

Requirements: Node.js 24+, pnpm 11.

```bash
pnpm install
pnpm check   # typecheck, lint, format check and tests
```

| Path                 | Purpose                                                                          |
| -------------------- | -------------------------------------------------------------------------------- |
| `packages/core`      | The pipeline and a command-line tool, independent of Premiere                    |
| `packages/sfx`       | Sound effect synthesis                                                           |
| `packages/companion` | Local service the panel talks to (render, transcription, keys, jobs)             |
| `packages/app`       | The menu bar app that runs the companion, installs the plugin and updates itself |
| `packages/panel`     | The Premiere Pro UXP panel                                                       |
| `styles/`            | Style presets                                                                    |
| `vendor/`            | Three.js, GSAP and fonts the animations load (with their licenses)               |
| `docs/`              | Architecture and notes (mostly Turkish)                                          |

The pipeline also runs without Premiere:

```bash
pnpm build
node packages/core/dist/cli.js run --audio part.wav --style kil-lacivert \
  --fps 30000/1001 --size 1920x1080 --out out/first
```

It writes `insert.mp4` (or a `.mov` with alpha when a scene sits over the footage), `preview.mp4`,
`sfx_mix.wav`, `sfx_stems/`, `stills/`, `plan.json`, `transcript.json` and the HyperFrames project.

Building the installers: `node packages/app/scripts/stage.mjs --pkg` on a Mac (signs and notarizes with the
maintainer's Developer ID), the Windows installer is built by the [Windows workflow](.github/workflows/windows.yml).

## License

Kilnframe is licensed under the [Apache License 2.0](LICENSE). The installers include FFmpeg (GPL), Chrome
for Testing, Electron, GSAP (GreenSock's no-charge license) and open source fonts; see [NOTICE](NOTICE).

---

## Türkçe

Kilnframe, Premiere Pro için ücretsiz ve açık kaynak bir eklenti. Timeline'da bir aralık seçersiniz,
Kilnframe o aralıktaki konuşmayı dinler ve söylenene uygun sahneler planlar: bir sayı için grafik, bir
süreç için diyagram, bir fikir için 3D bir metafor, güçlü bir cümle için büyük yazı. Her sahneyi HTML, CSS
ve JavaScript ile animasyon olarak yazar, sizin bilgisayarınızda render alır ve videoyu ses efektleriyle
birlikte aralığın üstüne yerleştirir.

- **On bir hazır stil ve kendi stiliniz.** Bir videoda tek stil kullanılır, bütün animasyonlar birbirini
  tutar.
- **Tam ekran ya da görüntünüzün üstünde.** Otomatik modda her sahne kendi karar verir: okunacak bir şey
  tam ekran gelir, kısa bir vurgu görüntünüzün üstüne, sizin durmadığınız tarafa gelir.
- **Render'dan önce onay.** Her sahneden bir kare gelir, beğenmediğiniz sahneyi bir notla yeniden
  ürettirirsiniz.
- **Ses efektleri ayrı izde.** Kodla üretilir, lisans derdi yoktur.
- **Kendi aboneliğiniz ya da anahtarınız.** Claude Code, Codex ya da Grok'u kendi planınızla
  kullanabilir ya da bir API anahtarı girebilirsiniz.
- **Render bilgisayarınızda.** Ses ve video dosyalarınız bilgisayarınızdan çıkmaz.

### Kurulum

Premiere Pro 2026 (25.6 ya da sonrası) ve ekran kartı olan bir bilgisayar gerekir.

- macOS, Apple silicon (M1 ve sonrası): [Kilnframe-mac.pkg](https://github.com/erhanmeydan/kilnframe/releases/latest/download/Kilnframe-mac.pkg)
- Windows 10 ya da 11, 64 bit: [Kilnframe-Windows.exe](https://github.com/erhanmeydan/kilnframe/releases/latest/download/Kilnframe-Windows.exe)

Intel işlemcili Mac'ler henüz desteklenmiyor.

1. Kurulum dosyasını açın. Kilnframe uygulamasını (menü çubuğunda ya da sistem tepsisinde küçük bir
   simge) ve Premiere eklentisini birlikte kurar.
2. Premiere'i yeniden başlatın ve **Window > UXP Plugins > Kilnframe** ile paneli açın.

Windows'ta SmartScreen "Bilgisayarınız korundu" diyebilir, çünkü kurulum dosyası henüz imzalı değil.
**Ek bilgi**'ye, sonra **Yine de çalıştır**'a basın. Mac kurulumu imzalı ve Apple onaylıdır.

Uygulama bilgisayarla birlikte açılır ve kendini güncel tutar. Yeni sürüm çıkınca panelde **Güncelle**
düğmesi görünür. Bir animasyon hazırlanırken asla güncellenmez. Konuşma tanıma modeli (yaklaşık 1 GB) ilk
animasyonda bir kez iner.

### Yapay zeka bağlantısı

Panelin ayarlarından (⚙) seçersiniz: Claude Code, Codex ya da Grok ile kendi aboneliğiniz; Claude, OpenAI,
Google Gemini, xAI, MiniMax ya da OpenRouter anahtarı; ya da LM Studio ile bilgisayarınızdaki bir model.
Sadece görsel okuyabilen modeller sunulur. Anahtarlar işletim sisteminin anahtar zincirinde saklanır.

Planla çalışmak için masaüstü uygulaması yetmez, terminaldeki program gerekir: Claude Code, Codex ya da Grok
Build. Claude Code için ücretli bir Claude planı gerekir. Kurulum komutları yukarıdaki tabloda ve
[ilk animasyon rehberinde](docs/ilk-animasyon.md); panel de bir program kurulu değilken Ayarlar'da gösterir.

### İlk animasyon

Adım adım, ekran görüntülü rehber: [docs/ilk-animasyon.md](docs/ilk-animasyon.md).

### Bilgisayarınızdan ne çıkar

Seçtiğiniz yapay zekaya sadece metin ve birkaç küçük kare gider: konuşmanın yazıya dökülmüş hali, sahne
planı, stilin tarifi ve Otomatik modda kadrajda nerede durduğunuzu görmesi için aralıktan üç kare. Ses ve
video dosyalarınız bilgisayarınızda kalır.

### Lisans

Apache License 2.0. Kurulum dosyalarındaki üçüncü taraf bileşenler [NOTICE](NOTICE) dosyasında.
