<p align="center"><img src="packages/app/assets/icon.png" width="112" alt="Kilnframe"></p>

<h1 align="center">Kilnframe</h1>

<p align="center">Animated inserts and music for Premiere Pro and DaVinci Resolve Studio, made from what you say.<br>
Select a range, pick a style, and a code-made animation with sound effects lands on your timeline.</p>

<p align="center"><a href="#türkçe">Türkçe</a></p>

---

Kilnframe is a free, open source plugin for Adobe Premiere Pro and DaVinci Resolve Studio. You mark an in/out range on the timeline;
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
- **Music for the whole video.** The Music tab scores the timeline or a range with Google Lyria, in sections
  that follow your topics, ducks it under your voice and places it on its own track.
- **Your plan or your key.** Use Claude Code, Codex or Grok with your own subscription, or an API key.
- **Renders locally.** Your audio and video never leave your computer.

## Install

You need Premiere Pro 2026 (26.2 or later) or DaVinci Resolve Studio 21.1 or later, and a computer with a
GPU. The free version of DaVinci Resolve does not load plugins: Resolve needs Studio.

|                                    | Download                                                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| macOS, Apple silicon (M1 or later) | [Kilnframe-mac.pkg](https://github.com/erhanmeydan/kilnframe/releases/latest/download/Kilnframe-mac.pkg)         |
| Windows 10 or 11, 64-bit           | [Kilnframe-Windows.exe](https://github.com/erhanmeydan/kilnframe/releases/latest/download/Kilnframe-Windows.exe) |

Intel Macs are not supported yet.

1. Open the installer. It installs the Kilnframe app (a small icon in the menu bar or the system tray), the
   Premiere plugin and, when Resolve Studio is installed, the Resolve panel in one go.
2. Restart Premiere, then open **Window > UXP Plugins > Kilnframe**. In Resolve, restart it and open
   **Workspace > Workflow Integrations > Kilnframe**.

On Windows, SmartScreen may say it protected your PC, because the installer is not code signed yet. Click
**More info**, then **Run anyway**. The Mac installer is signed and notarized by Apple.

The app starts with your computer and keeps itself up to date: when a new version is out, the panel shows
**Update**. It never updates while an animation is being made. The speech recognition model (about 1 GB) is
downloaded once, with the first animation.

## Connect an AI

Kilnframe writes the animations with a model you choose. Only models that can see images are offered: they
check the stills, match your style and find where you are in the frame.

| Way          | What you need                                                                      | Who pays                      |
| ------------ | ---------------------------------------------------------------------------------- | ----------------------------- |
| Claude plan  | [Claude Code](https://claude.com/claude-code), signed in                           | your Claude subscription      |
| ChatGPT plan | [Codex](https://github.com/openai/codex), signed in                                | your ChatGPT subscription     |
| Grok plan    | [Grok Build](https://x.ai/build), signed in                                        | your Grok subscription        |
| API key      | Claude, OpenAI, Google Gemini, xAI, MiniMax or OpenRouter                          | per use, on that account      |
| Local        | a vision model in [LM Studio](https://lmstudio.ai) or [Ollama](https://ollama.com) | free, slower, simpler results |

For LM Studio, load the model with a context of at least 64K tokens: a shorter one can run out while a
scene is written. For Ollama, set its context length to at least 64K in Ollama's settings: Ollama cuts a
longer prompt without saying so, so Kilnframe checks the context before it starts. For a model that thinks, the settings have a Thinking option, Off by default: faster, and
it uses less of the context.

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

## Music

1. Open the **Music** tab and choose **Whole Timeline** or **In/Out**. Write what you would like (calm piano,
   drums at the end) or leave it to the AI.
2. Press **Plan the Music**. Gemini, on the same Google key as the music, splits the speech into sections by topic, each with its mood, tempo and
   how it hands over to the next. Change a section's direction, join two, or leave one without music.
3. Press **Make the Music**. Google Lyria writes one piece per section. This needs a Google Gemini key
   (settings, Narration and Music) and costs about $0.08 per section on your Google account.
4. Listen to each section with your voice over it, make any section again with a note, then press
   **Place on the Timeline**: one clip per section on a new audio track.

The music sits around -21 dB on your audio meter while you speak, comes up in the pauses and
grows towards the end; set the level in the settings. All Lyria music carries Google's inaudible SynthID
watermark and its use follows Google's terms. Each job folder keeps a record of what made it
(`music/music.json`).

## Captions

1. Open the **Captions** tab and choose **Whole Sequence** or **In/Out**. Pick a look: Kil Navy, Loud,
   Dynamic, Pill, Karaoke, Typewriter, Calm, Band or Editorial, and change its colours if you like.
2. Add names and terms the speech uses (TopView, Claude) so they are spelt right, and choose **By the Spelling
   Rules** or **As Spoken**. Press **Prepare Captions**: the speech is written down on your computer and your
   AI corrects the spelling without touching the timing.
3. Under **Check the Text**, fix a word, split or join lines; the lines the AI changed are marked. **Play** shows a
   preview.
4. Press **Render and Place**. The captions land on a video track above your footage as one clip with
   transparency, and **Save the SRT File** gives you the same lines as subtitles.

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
For music, the sections' descriptions go to Google Lyria as text. Your audio and video files stay on your
computer. Rendering, speech recognition and sound effects run locally.

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
| `packages/panel`     | The Premiere Pro UXP panel and the DaVinci Resolve Workflow Integration panel    |
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

### Dependency updates

Every pinned dependency is listed in `deps.json`. A weekly workflow writes the newest stable versions to one
issue labelled `dependencies`. To try one update on a Mac: `pnpm deps:try <id>` (its own git worktree; tests,
then the golden scenes in `examples/golden/` rendered and compared with their reference frames). Add `--pr` to
open a pull request when everything passes. `pnpm deps:models` checks the providers' model lists with the keys
the app keeps in the keychain.

## License

Kilnframe is licensed under the [Apache License 2.0](LICENSE). The installers include FFmpeg (GPL), Chrome
for Testing, Electron, GSAP (GreenSock's no-charge license) and open source fonts; see [NOTICE](NOTICE).

---

## Türkçe

Kilnframe, Premiere Pro ve DaVinci Resolve Studio için ücretsiz ve açık kaynak bir eklenti. Timeline'da bir aralık seçersiniz,
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
- **Bütün videoya müzik.** Müzik sekmesi timeline'ı ya da bir aralığı Google Lyria ile konulara göre
  bölüm bölüm müzikler, konuşmanızın altında kısar ve ayrı bir ize yerleştirir.
- **Kendi aboneliğiniz ya da anahtarınız.** Claude Code, Codex ya da Grok'u kendi planınızla
  kullanabilir ya da bir API anahtarı girebilirsiniz.
- **Render bilgisayarınızda.** Ses ve video dosyalarınız bilgisayarınızdan çıkmaz.

### Kurulum

Premiere Pro 2026 (26.2 ya da sonrası) ya da DaVinci Resolve Studio 21.1 ya da sonrası, ve ekran kartı olan
bir bilgisayar gerekir. DaVinci Resolve'un ücretsiz sürümü eklenti yüklemez, Resolve için Studio gerekir.

- macOS, Apple silicon (M1 ve sonrası): [Kilnframe-mac.pkg](https://github.com/erhanmeydan/kilnframe/releases/latest/download/Kilnframe-mac.pkg)
- Windows 10 ya da 11, 64 bit: [Kilnframe-Windows.exe](https://github.com/erhanmeydan/kilnframe/releases/latest/download/Kilnframe-Windows.exe)

Intel işlemcili Mac'ler henüz desteklenmiyor.

1. Kurulum dosyasını açın. Kilnframe uygulamasını (menü çubuğunda ya da sistem tepsisinde küçük bir
   simge), Premiere eklentisini ve Resolve Studio kuruluysa Resolve panelini birlikte kurar.
2. Premiere'i yeniden başlatın ve **Window > UXP Plugins > Kilnframe** ile paneli açın. Resolve'da
   Resolve'u yeniden başlatın ve **Workspace > Workflow Integrations > Kilnframe**'i açın.

Windows'ta SmartScreen "Bilgisayarınız korundu" diyebilir, çünkü kurulum dosyası henüz imzalı değil.
**Ek bilgi**'ye, sonra **Yine de çalıştır**'a basın. Mac kurulumu imzalı ve Apple onaylıdır.

Uygulama bilgisayarla birlikte açılır ve kendini güncel tutar. Yeni sürüm çıkınca panelde **Güncelle**
düğmesi görünür. Bir animasyon hazırlanırken asla güncellenmez. Konuşma tanıma modeli (yaklaşık 1 GB) ilk
animasyonda bir kez iner.

### Yapay zeka bağlantısı

Panelin ayarlarından (⚙) seçersiniz: Claude Code, Codex ya da Grok ile kendi aboneliğiniz; Claude, OpenAI,
Google Gemini, xAI, MiniMax ya da OpenRouter anahtarı; ya da LM Studio veya Ollama ile bilgisayarınızdaki bir model.
Sadece görsel okuyabilen modeller sunulur. Anahtarlar işletim sisteminin anahtar zincirinde saklanır.
LM Studio'da modeli en az 64K bağlamla yükleyin, daha kısa bir bağlam sahne yazılırken yetmeyebilir.
Ollama'da ayarlardan bağlam uzunluğunu en az 64K yapın: Ollama daha uzun bir istemi haber vermeden kırpar,
Kilnframe bu yüzden işe başlamadan bağlamı kontrol eder.
Düşünen bir model için ayarlarda Düşünme seçeneği vardır ve varsayılan olarak Kapalı'dır: daha hızlıdır ve
bağlamı daha az kullanır.

Planla çalışmak için masaüstü uygulaması yetmez, terminaldeki program gerekir: Claude Code, Codex ya da Grok
Build. Claude Code için ücretli bir Claude planı gerekir. Kurulum komutları yukarıdaki tabloda ve
[ilk animasyon rehberinde](docs/ilk-animasyon.md); panel de bir program kurulu değilken Ayarlar'da gösterir.

### İlk animasyon

Adım adım, ekran görüntülü rehber: [docs/ilk-animasyon.md](docs/ilk-animasyon.md).

### Müzik

1. **Müzik** sekmesini açın, **Tüm Timeline** ya da **In/Out**'u seçin. İsteğinizi yazın (sakin piyano,
   finalde davul) ya da yapay zekaya bırakın.
2. **Müzik Planı Çıkar**'a basın. Müzikle aynı Google anahtarıyla Gemini konuşmayı konulara göre bölümlere ayırır; her bölümün havası,
   temposu ve bir sonrakine nasıl geçtiği yazar. Bir bölümün yönünü değiştirebilir, iki bölümü
   birleştirebilir ya da bir bölümü müziksiz bırakabilirsiniz.
3. **Müziği Üret**'e basın. Her bölümün müziğini Google Lyria yazar. Bunun için Google Gemini anahtarı
   gerekir (Ayarlar, Seslendirme ve Müzik); bölüm başına yaklaşık 0,08 dolar, Google hesabınızdan ödenir.
4. Her bölümü üstünde sesinizle dinleyin, istediğiniz bölümü bir notla yeniden ürettirin, sonra **Timeline'a
   Yerleştir**'e basın: her bölüm yeni bir ses izinde ayrı bir klip olur.

Siz konuşurken müzik ses göstergesinde yaklaşık -21 dB'de durur, boşluklarda yükselir, finale doğru
büyür; seviyeyi Ayarlar'dan değiştirebilirsiniz. Lyria'nın bütün müzikleri Google'ın duyulmayan SynthID
filigranını taşır ve kullanımı Google'ın koşullarına tabidir. Her iş klasöründe müziğin nasıl yapıldığının
kaydı durur (`music/music.json`).

### Altyazı

1. **Altyazı** sekmesini açın, **Tüm Sekans** ya da **In/Out**'u seçin. Bir görünüm seçin: Kil Lacivert,
   Loud, Dinamik, Hap, Karaoke, Daktilo, Sakin, Bant ya da Editoryal; isterseniz renklerini değiştirin.
2. Konuşmada geçen adları ve terimleri ekleyin (TopView, Claude) ki doğru yazılsın; **Yazım Kurallarına
   Göre** ya da **Konuşulduğu Gibi**'yi seçin. **Altyazıyı Hazırla**'ya basın: konuşma bilgisayarınızda
   yazıya dökülür, yapay zekanız zamanlamaya dokunmadan yazımı düzeltir.
3. **Metni Kontrol Et** bölümünde bir kelimeyi düzeltin, satırları bölün ya da birleştirin; yapay zekanın
   değiştirdiği satırlar işaretlidir. **Oynat** önizleme gösterir.
4. **Render Al ve Yerleştir**'e basın. Altyazı görüntünüzün üstündeki bir video izine şeffaf tek bir klip
   olarak gelir; **SRT Dosyasını Kaydet** aynı satırları altyazı dosyası olarak verir.

### Bilgisayarınızdan ne çıkar

Seçtiğiniz yapay zekaya sadece metin ve birkaç küçük kare gider: konuşmanın yazıya dökülmüş hali, sahne
planı, stilin tarifi ve Otomatik modda kadrajda nerede durduğunuzu görmesi için aralıktan üç kare. Müzik
için bölümlerin tarifleri metin olarak Google Lyria'ya gider. Ses ve video dosyalarınız bilgisayarınızda
kalır.

### Lisans

Apache License 2.0. Kurulum dosyalarındaki üçüncü taraf bileşenler [NOTICE](NOTICE) dosyasında.
