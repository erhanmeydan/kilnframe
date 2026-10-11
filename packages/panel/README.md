# Deneme paneli (M4 hazırlığı)

Bu panel, Premiere API'lerinin dokümandaki gibi çalışıp çalışmadığını Premiere'in içinde doğrulamak için var. Asıl eklenti paneli bu testlerin sonuçlarına göre yazılacak. API notları: `docs/premiere-uxp.md`.

## Kurulum (bir kez)

1. Premiere'de Ayarlar > Plugins > **Enable developer mode** seçeneğini aç ve Premiere'i yeniden başlat.
2. Creative Cloud Desktop'tan **UXP Developer Tool** (2.2 veya üstü) kur.
3. Terminalde paneli derle:

```bash
pnpm --filter @kilnframe/panel build
```

4. UXP Developer Tool'da **Add Plugin** ile `packages/panel/dist/manifest.json` dosyasını seç, sonra **Load**.
5. Premiere'de Window > UXP Plugins > **kilnframe probe**.

## WAV preset'i (3. test için)

Premiere'de File > Export > Media penceresinde formatı **Waveform Audio** yap, 48 kHz 16 bit seç ve **Save Preset** ile bir `.epr` dosyası kaydet. Yolunu paneldeki kutuya yapıştır.

## Test sırası

Bir sekans aç ve bir in/out aralığı işaretle.

1. **Sekans bilgisi:** in/out, iş alanı, kare hızı (tam kesir olarak, örneğin 30000/1001), boyut ve track sayıları. Sonra in/out'u kaldırıp tekrar bas: in/out yokken ne döndüğünü görmek istiyoruz.
2. **Kare dışa aktar:** in noktasındaki kareyi `~/.kilnframe/probe/probe-in.png` olarak yazar.
3. **Ses dışa aktar:** tüm sekansın sesini preset ile `~/.kilnframe/probe/probe-sequence.wav` olarak yazar.
4. **Companion:** önce yardımcı uygulamayı başlat (aşağıda), sonra bas. Hem `127.0.0.1` hem `localhost` ile bağlanmayı dener ve sistem kontrolünün sonucunu gösterir. Manifest'teki ağ izninin doğru olup olmadığını bu test söyler.
5. **Import + yerleştir:** yazdığın dosyayı "Kilnframe" klasörüne alır ve in noktasına, en üstteki track'in bir üstüne yerleştirmeyi dener. Cmd+Z ile geri alınabilir. Örnek dosya: `out/flat-veri/insert.mp4`.

Yardımcı uygulamayı başlatmak için:

```bash
node packages/companion/dist/main.js
```

Her butonun çıktısı panelin altındaki kutuda görünür. Kutudaki metni kopyalayıp bana yapıştırman yeterli.
