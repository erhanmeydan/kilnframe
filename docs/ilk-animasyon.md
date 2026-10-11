# İlk animasyonunu yap

Bu rehber Kilnframe'i ilk kez kullanan editörler için. Premiere'de bir aralık seçip birkaç tıklamayla konuya uygun, ses efektli bir animasyon üretmeyi ve timeline'a yerleştirmeyi anlatır.

> Taslak (9 Ekim 2026). Ekran görüntüleri yayından önce eklenecek.

## 1. Kurulum

Gerekenler: Premiere Pro 2026 (25.6 ya da sonrası), ekran kartı olan bir bilgisayar ve yaklaşık 2 GB boş yer (uygulama ve konuşma modeli).

Tek bir kurulum dosyası indirirsiniz. İçinden hem Kilnframe uygulaması hem Premiere eklentisi kurulur.

- **Mac (Apple silicon, M1 ve sonrası):** [Kilnframe-mac.pkg](https://github.com/erhanmeydan/kilnframe/releases/latest/download/Kilnframe-mac.pkg)
- **Windows 10 ya da 11, 64 bit:** [Kilnframe-Windows.exe](https://github.com/erhanmeydan/kilnframe/releases/latest/download/Kilnframe-Windows.exe)

Bu bağlantılar her zaman en son sürümü indirir.

### Mac

1. `Kilnframe-mac.pkg` dosyasına çift tıklayın ve adımları izleyin. Sonda Mac parolanızı sorar.
2. Kurulum bitince menü çubuğunda Kilnframe simgesi (kemerli küçük bir fırın) belirir.
3. Bir bildirim "Eklenti kuruldu. Premiere'i yeniden başlatın." der.
4. Premiere açıksa kapatıp yeniden açın.

### Windows

1. `Kilnframe-Windows.exe` dosyasına çift tıklayın.
2. Windows "Bilgisayarınız korundu" diyebilir. Kurulum dosyası henüz imzalı olmadığı için bu normal. **Ek bilgi**'ye, sonra **Yine de çalıştır**'a basın.
3. Kurulum bitince sistem tepsisinde (saatin yanında) Kilnframe simgesi belirir ve eklenti Premiere'e kurulur.
4. Premiere açıksa kapatıp yeniden açın.

### Uygulama ne yapar

Kilnframe uygulaması arka planda çalışan küçük bir yardımcıdır. Penceresi yoktur, sadece simgesi görünür. Render, konuşma tanıma ve ses efektleri onun içinde, sizin bilgisayarınızda yapılır. Bilgisayar açılınca kendiliğinden başlar. Simgenin menüsünden günlüğü görebilir, eklentiyi yeniden kurabilir ya da uygulamadan çıkabilirsiniz.

### Güncellemeler

Yeni bir sürüm çıkınca panelin üstünde "Kilnframe 0.2.0 hazır" yazar ve **Güncelle** düğmesi görünür. Basınca uygulama yeni sürümü indirir, kapanıp yeniden açılır. Eklenti de birlikte yenilenir, Premiere'i bir kez yeniden başlatmanız yeterli. Bir animasyon hazırlanırken güncelleme yapılmaz.

## 2. Paneli açmak

Premiere'de **Window > UXP Plugins > Kilnframe** ile paneli açın. Panel yardımcı uygulamaya kendisi bağlanır. Bağlanamazsa üstte bir uyarı ve **Yeniden Dene** düğmesi görünür.

Panel doğrudan ana ekranla açılır. Bilgisayarınızda Claude Code giriş yapılmışsa hemen animasyon üretebilirsiniz; konuşma modeli (yaklaşık 1 GB, bir kez) ilk animasyonda kendiliğinden iner. Adım adım bir kurulum isterseniz **Ayarlar › Kurulum Rehberini Aç**: yardımcı uygulamayı ve bilgisayarı kontrol eder, konuşma modelini ilerleme çubuğuyla indirir, yapay zeka sağlayıcısını ve isteğe bağlı Gemini anahtarını sorar.

### Yapay zeka: masaüstü uygulaması yetmez

Planınızla çalışmak için Kilnframe terminalde çalışan programları kullanır: **Claude Code**, **Codex** (ChatGPT) ya da **Grok Build**. Claude, ChatGPT ya da Grok'un masaüstü uygulamasını kurmuş olmanız yetmez. Claude Code için ücretli bir Claude planı gerekir (Pro, Max, Team ya da Enterprise). Programı kurmak için Mac'te Terminal'e, Windows'ta PowerShell'e yapıştırın:

| Program     | Mac                                                     | Windows                                                                                    |
| ----------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Claude Code | `curl -fsSL https://claude.ai/install.sh \| bash`       | `irm https://claude.ai/install.ps1 \| iex`                                                 |
| Codex       | `curl -fsSL https://chatgpt.com/codex/install.sh \| sh` | `powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 \| iex"` |
| Grok Build  | `curl -fsSL https://x.ai/cli/install.sh \| bash`        | `irm https://x.ai/cli/install.ps1 \| iex`                                                  |

Sonra yeni bir pencerede `claude`, `codex` ya da `grok` yazıp tarayıcıda giriş yapın. Panel bu komutları, bir program kurulu değilken Ayarlar'da da gösterir. Planınız yoksa bir API anahtarıyla da çalışabilirsiniz.

Panelin dili Premiere'in diline göre açılır. Ayarlardan (sağ üstteki ⚙) İngilizce ya da Türkçe seçebilirsiniz.

## 3. Aralıktan animasyon üretmek

1. Timeline'da In ve Out noktalarıyla bir aralık seçin. Seçmezseniz bütün sekans kullanılır.
2. **Aralıktan Üret** sekmesinde bir stil seçin. Seçtiğiniz stil bu videonun bütün animasyonlarında kullanılır ve sekansla birlikte hatırlanır.
3. İsterseniz format (Orijinal, Yatay, Dikey, Kare), yerleşim ve kısa bir not seçin. Logo, ürün görseli ya da ekran görüntüsü eklemek için **Görsel Ekle**'yi kullanın.
4. **Animasyon Oluştur**'a basın.

Panel adım adım ilerlemeyi gösterir: ses yazıya dökülür, sahneler planlanır, her sahnenin kodu yazılır. Kod yazma birkaç dakika sürebilir. Panel kaç sahnenin bittiğini yazar ("7 sahneden 4 tanesi yazıldı").

**Arka Planda Sürsün** ile panelden çıkabilirsiniz, iş yardımcı uygulamada devam eder.

### Yerleşim: Otomatik, Tam Ekran, Üst Katman

- **Otomatik** (önerilen): Her sahne için konuya göre karar verilir. Okunması gereken bir grafik, adım adım bir süreç ya da asıl fikir tam ekran gelir. Kısa bir vurgu, isim ya da anahtar kelime görüntünüzün üstüne, sizin yanınıza gelir. Panel aralıktan birkaç kare alır, sizin kadrajın neresinde durduğunuzu bulur ve grafikleri boş tarafa yerleştirir.
- **Tam Ekran**: Bütün sahneler görüntünün yerine geçer.
- **Üst Katman**: Bütün sahneler görüntünüzün üstüne, boş tarafa gelir.

Üst katman içeren bir animasyon şeffaf arka planlı `.mov` (ProRes 4444) olarak gelir. Tam ekran sahneler bu dosyada kendi arka planlarıyla durur, timeline'da yine tek klip olur. Windows'ta dosyaya çift tıklayınca açılmazsa sorun değil, Premiere bu dosyaları okur.

Hikayeden üretilen sekanslarda altta konuşan biri olmadığı için Otomatik her zaman tam ekran üretir.

### Uzun aralıklar

45 saniyeden uzun bir aralık, cümle sonlarından kesilerek yaklaşık 30 saniyelik parçalara bölünür. Her parça sırayla onayınıza gelir ve hepsi aynı izlere arka arkaya yerleşir. Parçalar aynı görsel dünyada kalır.

## 4. Kareleri onaylamak

Kod yazıldıktan sonra her sahneden bir kare gelir. Üst katman sahneler sizin görüntünüzün üstünde gösterilir, böylece grafiğin yüzünüzü kapatıp kapatmadığını render'dan önce görürsünüz.

- Bir kareye tıklayınca büyür, **Önceki** ve **Sonraki** ile gezebilirsiniz.
- Beğenmediğiniz sahnenin adına tıklayın, ne istediğinizi bir notla yazın ve sadece o sahneyi yeniden ürettirin.
- Her şey yerindeyse **Onayla ve Render Al**'a basın.
- **Vazgeç** işi bırakır. Dosyalar iş klasöründe kalır.

## 5. Sonuç timeline'da

Render bitince panel animasyonu ve ses efektlerini seçtiğiniz aralığın üstüne yerleştirir:

- Animasyon, kullanılan en üst video izinin üstündeki ilk boş ize gelir. Böylece görüntünüzün ve başlıklarınızın üstünde kalır.
- Ses efektleri ayrı bir ses izine, tek klip halinde gelir. Seviyesini istediğiniz gibi ayarlayabilirsiniz.
- Klipler baştan ve sondan pay bırakılarak gelir. Kenarlarından uzatıp kısaltabilirsiniz.

Hiçbir şeyin üzerine yazılmaz: boş iz yoksa yeni iz açılır. Her yerleştirme tek adımda geri alınabilir (**Edit > Undo**).

## 6. Hikayeden üretmek

Elinizde ses kaydı yoksa **Hikayeden Üret** sekmesi bir konudan bitmiş bir video çıkarır.

1. Hikayenin ne hakkında olduğunu yazın, süre, dil ve isterseniz ton seçin. **Hikayeyi Yaz**'a basın.
2. Gelen metni istediğiniz gibi düzenleyin ya da bir notla yeniden yazdırın.
3. Bir ses seçin. **Dinle** ile önce kısa bir örnek dinleyebilirsiniz.
4. Formatı seçin: Orijinal, açık sekansın ölçüsünü korur. Reels ve Shorts için Dikey, YouTube için Yatay seçin.
5. Müzik: **Sesin Altında** seçiliyse seçili stilin havasında enstrümantal bir müzik üretilir. Anlatıcı konuşurken kısılır, aralarda yükselir.
6. **Seslendir ve Yeni Sekansa Ekle**'ye basın. Seslendirme A1'e, müzik A2'ye yerleşmiş yeni bir sekans açılır.
7. **Aralıktan Üret** sekmesine geçip bir stil seçin ve **Animasyon Oluştur**'a basın.

Hikaye sekanslarında yazıya dökme müzikli sesten değil, temiz seslendirmeden yapılır. Kelimeler hikaye metninden alınır, isimler yazdığınız gibi çıkar.

## 7. Sık karşılaşılan sorunlar

### Düğmeye bastım, bir şey olmadı

Premiere arka plandayken (örneğin başka bir uygulamaya geçmişken) panele yapılan ilk tıklama sadece Premiere'i öne getirir, düğmeye ulaşmaz. Bu Premiere eklenti panellerinin bir sınırı. Panel bu durumda düğmeleri soluk gösterir. Düğmeler parlaksa tıklama çalışır.

Ne yapmalı: düğmeye bir kez daha basın.

### Kod yazma adımı çok uzun sürüyor

Her sahnenin kodu ayrı yazılır ve sahne sayısına göre birkaç dakika sürebilir. Panel biten sahneleri sayar ve geçen süreyi gösterir. Sayı ilerliyorsa iş sürüyordur.

### Bir karede yazı bozuk ya da üst üste binmiş

O sahnenin adına tıklayın, örneğin "başlık düz ve okunur dursun" diye not yazın ve sadece o sahneyi yeniden ürettirin.

### Yardımcı uygulamaya bağlanılamadı

Menü çubuğunda (Windows'ta sistem tepsisinde) Kilnframe simgesinin olduğundan emin olun. Yoksa Uygulamalar klasöründen (Windows'ta Başlat menüsünden) Kilnframe'i açın. Sonra paneldeki **Yeniden Dene**'ye basın.

### Claude Code kurulu ama panel "kurulu değil" diyor

Önce Claude Code'u kurduğunuzdan emin olun: Claude masaüstü uygulaması Claude Code değildir (bkz. bölüm 2). Claude Code'u Kilnframe açıkken kurduysanız panelde **Yeniden Bak**'a basın. Yine görünmezse menü çubuğundaki Kilnframe simgesinden **Kilnframe'den Çık** deyip uygulamayı yeniden açın. Uygulama, açılırken bilgisayarınızda kurulu programların yerini yeniden okur.

### Panel "eklentiyi güncelleyin" ya da "uygulamayı güncelleyin" diyor

Panel ile uygulamanın sürümleri uyuşmuyor. Panel hangisinin eski olduğunu yazar. Uygulama eskiyse yeni kurulum dosyasını indirip kurun. Eklenti eskiyse menü çubuğundaki Kilnframe simgesinden **Eklentiyi Premiere'e Kur**'u seçin ve Premiere'i yeniden başlatın.

### Hikaye modunda anahtar istiyor

Seslendirme ve müzik için bir Google Gemini anahtarı gerekir. Anahtar girişi panelin ayarlarına eklenecek (yapılacak). O zamana kadar anahtar yardımcı uygulama üzerinden işletim sisteminin anahtar zincirine kaydedilir.
