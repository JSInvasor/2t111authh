# 2t1auth

Luarmor tarzı, Roblox script'leri için **kimlik doğrulama & lisanslama** sistemi.
Bu ilk sürüm çekirdeği içerir: **Auth API + Lua Loader**.

```
Kullanıcı executor'da:            Sunucu:
  script_key = "..."       ─────▶  key + HWID doğrula
  loadstring(HttpGet(          ◀── geçerliyse korunan script'i döndür
    ".../loader/<id>.lua"))()
```

## Özellikler

- 🛡️ **Anti-tamper** — **karşılıklı doğrulanan** handshake (sunucu da kendini kanıtlar), key hiç ağa çıkmaz, **HMAC-SHA256 proof**, **imzalı cevap** (düz metne düşürülemez), **oturum anahtarlı teslimat** (payload kendi anahtarını taşımaz), obfuscate edilmiş loader, anti-hook/anti-dump, executor allowlist, key-paylaşımı (HWID **ve** IP) oto-ban
- 🔒 **Obfuscation** — teslim anında minify + RC4 şifreleme; script düz metin sızmaz
- 👥 **Reseller sistemi** — alt-bayi hesapları, kredi/kota (1 key = 1 kredi), script atama, kapsamlı yetki (bayi kaynak kodu göremez, sadece kendi key'lerini yönetir), rol-bazlı panel
- 🤖 **Discord bot** — `/getkey`, `/resethwid`, `/info` + admin komutları; role-bazlı whitelist, log kanalı
- 🖥️ **Web Dashboard** — tarayıcıdan script/key yönetimi, canlı istatistik, tek tıkla loader snippet'i (oturum tabanlı login)
- 🔑 **Key sistemi** — key üretme (tekli/toplu), süre (expiry), not, Discord id
- 🖥️ **HWID kilidi** — key ilk kullanımda cihaza bağlanır, başka cihazda çalışmaz
- 🚫 **Ban / pause** — key'i anında devre dışı bırakma
- 📊 **İstatistik** — execution sayısı, benzersiz HWID, başarı/başarısızlık, son çalışmalar
- 🪝 **Loader** — Roblox executor'ları için hazır Lua bootstrap (HWID = `RbxAnalyticsService:GetClientId()`)
- 🛡️ **Güvenlik** — admin API key + oturum çerezi, rate limiting, helmet + CSP, scrypt parola hash, constant-time karşılaştırma, **executor blacklist**, startup config doğrulama
- 🧰 **Bakım modu** — script'i tek tıkla devre dışı bırak (tüm auth reddedilir)
- 📈 **Overview** — tüm projeler için toplu istatistik (24s execution, aktif kullanıcı), **CSV export**
- ✅ **Test paketi** — `npm test` (auth, key, HWID, session, obfuscation, SHA-256, uçtan uca HTTP + **gerçek loader gerçek Lua VM'de**), graceful shutdown, request logging
- 🐳 **Docker** — `docker compose up` ile tek komut deploy alternatifi

> Bir sonraki adım için fikir: daha güçlü koruma (bytecode/VM tabanlı obfuscation), Postgres'e geçiş, kullanım analitiği/grafikler.

## Kurulum

```bash
npm install
npm run create-admin -- admin SENIN_SIFREN   # dashboard giriş hesabı
npm run seed                                 # (opsiyonel) örnek script + 3 key
npm start                                    # http://localhost:3000
```

Sonra tarayıcıda **http://localhost:3000/dashboard/** adresini aç ve oluşturduğun
hesapla giriş yap.

`.env` dosyası hazır (rastgele `ADMIN_API_KEY` ve `SESSION_SECRET` ile). Üretimde
`BASE_URL`'yi gerçek domain'ine çevir, `.env`'i gizli tut ve mutlaka **HTTPS** kullan.

## Dashboard

`/dashboard/` altında çalışan web paneli:

- **Scripts** — tüm projeleri kart olarak listeler; "+ New Script" ile yeni script + otomatik loader
- **Script detay** — canlı istatistik kartları, kopyalanabilir loader snippet'i, ayarlar (isim/versiyon/HWID kilidi/kaynak kod)
- **Key yönetimi** — toplu key üretme (adet/süre/not), arama, ban/unban, HWID reset, silme, tek tık kopyalama

Giriş oturum çerezi ile yapılır (master `ADMIN_API_KEY` tarayıcıya hiç gönderilmez).
Yeni admin eklemek / şifre değiştirmek için: `npm run create-admin -- <kullanıcı> <şifre>`.

### Arayüz

- **Açık / koyu tema** — ilk açılışta işletim sistemi tercihini izler, sol alttaki
  düğmeyle değiştirilir; seçim `localStorage`'da saklanır.
- **Tipografi** — arayüzde Quicksand (geometrik, yuvarlak uçlu), key/HWID/ID gibi
  teknik alanlarda Geist Mono. İkisi de OFL lisanslı; `.woff2` dosyaları
  `public/fonts/` altında **kendi sunucumuzda**, CDN'e istek gitmez.
  Quicksand aynı sayısal ağırlıkta daha ince bastığı için CSS'teki `font-weight`
  değerleri buna göre kalibre edilmiştir — fontu değiştirirsen bunları da gözden geçir.
- **İkonlar** — Lucide, SVG olarak `app.js` içine gömülü. CSP `script-src 'self'`
  olduğu için harici ikon kütüphanesi yüklenmez.
- Panel tek sayfa (hash router) çalışır, harici JS/CSS bağımlılığı yoktur ve
  mobilde açılır menüye düşer.

## Discord Bot

Bot, dashboard ile **aynı veritabanını** kullanır (ayrı bir servis). Bir Discord
projesine bir script atanır (`DISCORD_SCRIPT_ID`).

**Kurulum:**

1. https://discord.com/developers/applications → New Application → Bot oluştur, **token** al.
2. `.env` içine doldur: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID` (Application ID),
   `DISCORD_GUILD_ID` (test sunucun), `DISCORD_SCRIPT_ID` (dashboard'daki bir script id).
3. Botu sunucuna davet et (OAuth2 URL: scopes `bot applications.commands`).
4. Komutları kaydet, sonra botu başlat:

```bash
npm run bot:register
npm run bot
```

**Komutlar:**

| Komut                             | Kim       | Açıklama                                                   |
| --------------------------------- | --------- | ---------------------------------------------------------- |
| `/getkey`                         | Whitelist | Key'ini alır (yoksa oluşturur), loader snippet'i ile       |
| `/resethwid`                      | Herkes    | Kendi HWID'ini sıfırlar (cooldown + limit uygulanır)       |
| `/info`                           | Herkes    | Key durumu (status, HWID, expiry, execution, reset sayısı) |
| `/generate <count> [days] [note]` | Admin     | Toplu key üretir                                           |
| `/lookup <key>`                   | Admin     | Key detayını gösterir                                      |
| `/ban <key>` / `/unban <key>`     | Admin     | Key'i banlar / açar                                        |

Ayarlar (`.env`): `DISCORD_WHITELIST_ROLE_ID` (boşsa herkes `/getkey` kullanabilir),
`DISCORD_ADMIN_ROLE_ID` (sunucu yöneticileri her zaman yetkili), `DISCORD_LOG_CHANNEL_ID`
(key/reset logları), `DISCORD_KEY_EXPIRES_DAYS` (getkey ile verilen key'lerin varsayılan süresi).

> **Not:** Node 18.16 uyumu için `discord.js@14.14.1` sabitlendi (deprecation uyarısı normal).
> Daha yeni/patch'li discord.js için Node'u **20 LTS**'e yükseltmen önerilir.

## Obfuscation

Her script için açılıp kapatılabilen (dashboard'da **🔒 Protected** rozeti) koruma
katmanı. Kaynak kod **düz saklanır**, yalnızca **teslim anında** ([src/services/auth.js](src/services/auth.js))
işlenir:

1. **Minify + local rename** (`luamin`) — gerçek Lua AST'i ile. Script Luau'ya özgü
   sözdizimi içerip parse edilemezse bu adım **otomatik atlanır** (script asla bozulmaz).
2. **RC4 şifreleme** — iki mod:
   - **oturum modu** (anti-tamper açıkken varsayılan): anahtar `SHA256(salt|nonce|script|key|hwid)`
     ile iki tarafta ayrı ayrı türetilir ve stub'a `...` (vararg) olarak verilir —
     **payload'ın içinde anahtar yoktur**, yakalanan cevap tek başına çözülemez.
   - **inline mod**: anahtar stub'ın içinde. Loader bootstrap'ı (henüz oturum yokken) ve
     `ANTI_TAMPER=0` bunu kullanır.
3. **Lua çözücü stub** — base64 + RC4 çözer, **çift checksum** ile bütünlüğü doğrular,
   `loadstring`'in C closure olduğunu kontrol eder, sonra çalıştırır; değişken adları
   her teslimde rastgele.

Çözücü stub yalnızca `string`, `table`, `math`, `bit32` (yoksa saf-Lua XOR fallback) ve
`loadstring/load` kullanır — tüm Roblox executor'larında çalışır.

> **Kapsam:** Bu, statik okuma/dump'ı engelleyen **temel-orta seviye** korumadır. Luarmor'un
> bytecode-VM seviyesine ulaşmaz (o ayrı bir dev proje). Gerçek gizlilik için sunucu
> **HTTPS** arkasında olmalı (aksi halde trafik dinlenebilir).

## Reseller sistemi

Admin, **bayi (reseller)** hesapları oluşturur; bayiler kendilerine **atanmış script'ler**
için key üretir. Her key **1 kredi** düşer.

- **Kapsam:** Bayi kaynak kodu göremez, script oluşturamaz/düzenleyemez, başka bayinin
  key'lerini veya genel istatistiği göremez — yalnızca kendi ürettiği key'leri yönetir.
- **Rol-bazlı giriş:** Aynı `/dashboard/` — admin girince tam panel + **Resellers** sayfası,
  bayi girince sadece kendi paneli (kredi + atanan script'ler + kendi key'leri). Rol oturum
  çerezinde taşınır.
- **Admin:** bayi oluştur, kredi ekle/çıkar, script ata/kaldır, aç/kapat, şifre sıfırla, sil.

**Admin API** (`/api/v1/resellers`): `POST /` (oluştur), `GET /`, `GET /:id`,
`PATCH /:id` (enabled/password), `POST /:id/credits`, `POST /:id/scripts`,
`DELETE /:id/scripts/:scriptId`, `DELETE /:id`.

**Reseller API** (`/api/v1/reseller/*`, bayi çerezi): `GET /me` (kredi + atanan script'ler),
`GET /keys?script_id=`, `POST /keys` (kredi düşer), `PATCH /keys/:id`,
`POST /keys/:id/ban|unban|pause|reset-hwid`, `DELETE /keys/:id` (hepsi sadece kendi key'lerinde).

## Anti-tamper

Protokol **çift taraflı** doğrulanır ve dayanağı **lisans key'i**: istemciyle sunucunun
zaten paylaştığı tek sır. Key'in kendisi hiç ağa çıkmaz — istemci kendini
`kh = SHA256("2t1kh|"..key)` ile tanıtır, iki taraf da gerçek key'i bildiğini HMAC ile
kanıtlar.

```
loader                                   sunucu
  │  POST /handshake {script_id, kh}        │   key değil, hash'i gider
  │ ◀── {nonce, salt, ttl, server_proof} ───┤   server_proof = HMAC(key, 2t1srv|nonce|salt|script)
  │                                         │
  │  ★ server_proof DOĞRULANIR              │   ← sunucu burada kimliğini kanıtlar.
  │    tutmazsa loader durur, hiçbir şey    │     Key'i bilmeyen bir uç nokta buradan
  │    göndermeden çıkar                    │     geçemez; elinde sadece kh kalır.
  │                                         │
  │  proof = HMAC(key, 2t1cli|nonce|script|hwid|executor)
  │  POST /auth {script_id, kh, …, proof} ─▶│   proof doğrulanır, nonce yakılır
  │ ◀── {script, enc, resp_proof} ──────────┤   resp_proof = HMAC(key, 2t1res|nonce|enc|script)
  │     RC4(payload, SHA256(salt|nonce|script|key|hwid))
  │                                         │
  │  ★ resp_proof DOĞRULANIR + enc="session" zorunlu
  │  aynı anahtarı kendi hesaplar → çözer → çalıştırır
```

**Sunucu tarafı (istemci kurcalansa bile geçerli):**

- **Karşılıklı doğrulama** — `server_proof` olmadan loader devam etmez. HTTP'ye cevap
  verebilen ama key'i bilmeyen hiçbir şey (düşman proxy, zehirlenmiş DNS, captive portal)
  bu satırı geçemez. Öncesi bir dönem bu adım yoktu ve loader, imzasız bir cevaptaki düz
  metin Lua'yı çalıştırıyordu — key, nonce, proof gerekmeden.
- **Key ağda taşınmaz** — istek `kh` taşır. Yakalanan ya da düşman bir uç noktaya düşen
  trafikten geri döndürülebilir bir şey çıkmaz (key ~160 bit entropi).
- **Cevap imzası** — `resp_proof` payload'ı **ve `enc` alanını** kapsar, yani cevap yolda
  değiştirilemez ve oturum şifrelemesinden düz metne **düşürülemez**. Zorunluluk render
  anında loader'a gömülür: sunucunun politikasıdır, cevabın ikna edebileceği bir şey değil.
- **Oturum proof'u** — auth isteği key ile HMAC-SHA256'lanmış olmak zorunda. Yakalanan bir
  isteğin **hiçbir alanı** (hwid, executor) değiştirilip yeniden gönderilemez.
- **Key oracle yok** — bilinmeyen bir `kh` için handshake, aynı şekle sahip bir **decoy**
  proof döner; cevaba bakarak bir key'in var olup olmadığı anlaşılamaz.

### Canlı oturumlar (lease + heartbeat)

Auth eskiden **tek atımlıktı**: bir kez doğrula, script'i al, bir daha görüşülmez. Key'i
banlamak yalnızca **bir sonraki** auth'u durduruyordu; o an çalışan kopya kullanıcı oyunu
kapatana kadar çalışmaya devam ediyordu. Ve "bu key paylaşılıyor mu?" sorusu ancak
log'daki farklı HWID'leri sayarak **tahmin** edilebiliyordu — ki bu, wifi'dan mobil veriye
geçen dürüst kullanıcıyı da bir key'i paylaşan iki kişi kadar kolay işaretler.

Başarılı auth artık bir **lease** açıyor; loader periyodik olarak ona vuruyor:

```
POST /api/v1/heartbeat { lease, n, beat }     beat = HMAC(key, 2t1hb|lease|n)
  → { success: true }                          devam
  → { success: false, revoked: true }          dur
```

- **Çalışan script'e ulaşan iptal** — ban/pause/silme, o anda açık oturumları da düşürür.
- **Paylaşım artık tahmin değil** — bir key'de iki canlı lease, geçmişe dair istatistiksel
  bir çıkarım değil, **şu anda** iki yerde açık bir hesap demek. Limit aşılınca **en eski**
  oturum düşürülür (yeni gelen reddedilmez), böylece oyunu çöken kullanıcı anında geri
  girebilir; asıl sinyal biriken **tahliye** sayısıdır (`concurrent_session`).
- **Beat sahtelenemez ve tekrarlanamaz** — key ile HMAC'li ve sayacı kesin artan, yani
  yakalanan bir beat iptal edilmiş bir oturumu ayakta tutamaz.
- **Çok cihazlı satış** — `LEASE_MAX_PER_KEY` ile 1 key = N eşzamanlı oturum.

### Risk skoru (ikili oto-ban yerine)

Eskiden her otomatik ban **tek sinyal genişliğindeydi**: N HWID'i aş → ban. N IP'yi aş →
ban. N rapor → ban. Bunların hepsi gerçek müşterilerin yaptığı şeylerde tetikleniyor —
ağ değiştiren telefon, yeniden kurulum, kullanıcının kendi ikinci cihazı. Ve **yanlışlıkla
banlanmış bir ödeme yapan müşteri, fazladan bir oturum kapmış bir korsandan çok daha
pahalıdır.** Bu ürünleri ticari olarak öldüren şey korsanlık değil, bu asimetridir.

Sinyaller artık tek tek tetik çekmiyor, **0-100 arası bir skorda toplanıyor**:

| Faktör          | Tavan | Ne ölçer                                                       |
| --------------- | ----- | -------------------------------------------------------------- |
| `devices`       | 30    | Pencere içindeki farklı HWID sayısı                            |
| `networks`      | 25    | Farklı **ağ** sayısı (/24, /64 — adres değil)                  |
| `concurrency`   | 30    | Başka bir oturumu düşüren oturum sayısı — **en keskin sinyal** |
| `tamper`        | 20    | İstemci bütünlük raporları (key sahipliği kanıtlanmış)         |
| `environment`   | 15    | Ortam parmak izinin kaç kez değiştiği                          |

- **Hiçbir faktör tek başına ban eşiğine ulaşamaz** (tavanlar `RISK_BAN_AT`'in altında) —
  yani tek bir tuhaf-ama-masum davranış asla tek başına banlayamaz.
- `RISK_WATCH_AT` (45) → panelde işaretle, servis vermeye devam et.
  `RISK_BAN_AT` (85) → servis dışı bırak. Eşik bilinçli olarak yüksek.
- Karar **açıklanabilir**: `risk.explain()` hangi faktörün kaç puan kattığını söyler,
  yani "bu neden banlandı?" sorusunun bir cevabı var.

### Ölçekleme sınırı (bilinçli)

Handshake ve lease durumu **bu process'in belleğinde** tutulur. Bu, **tek instance**
çalıştırman gerektiği anlamına gelir:

- PM2 cluster mode, `WEB_CONCURRENCY > 1`, birden fazla replica → handshake bir
  process'te açılır, auth diğerine düşer ve kullanıcı "invalid or expired session" alır.
  Rastgele görünen, deploy topolojisi dışında her şeye yıkılan türden bir hata.
- Bu yüzden `validateConfig` bunu **başlangıçta tespit edip hata veriyor** (PM2 `pm_id`,
  `NODE_APP_INSTANCE`, `WEB_CONCURRENCY`, `instances`) — üretimde keşfetmek yerine.
- Yatay ölçeklemek istiyorsan `src/services/nonce.js` ve `src/services/lease.js`
  içindeki `Map`'leri paylaşımlı bir store'a (Redis) taşımak gerekir; ikisi de küçük ve
  kendi içinde kapalı. Şimdilik dikey ölçekle.

> Not: sunucu tarafı garanti kesindir (iptal edilen key yeniden auth olamaz, lease ölür).
> Çalışmakta olan script'i **süreç içinde durdurmak** ise iş birliğine dayanır: loader
> `getgenv().__2t1.revoked` bayrağını set eder, script bunu kontrol edip kendi kapanır.
> Hiçbir şey, script'in çoktan kurduğu bağlantıları güvenle söküp atamaz.
- **Oturum anahtarlı teslimat** — payload'ın RC4 anahtarı artık payload'ın içinde
  **taşınmıyor**; iki taraf da `SHA256(salt|nonce|script|key|hwid)` ile bağımsız türetiyor.
  Proxy log'una düşen ya da Discord'da paylaşılan bir cevap, o oturum olmadan **çözülemez**.
- **Replay** — nonce tek kullanımlık (başarısız denemede de yakılır), ~20s ömürlü,
  script'e, key'e ve (varsayılan olarak) isteği alan **ağa** bağlı. Bağlama tam IP
  değil **/24 (v4) ve /64 (v6) prefix'i** üzerinden yapılır: relay/bayi-röle senaryosunu
  hâlâ engeller, ama wifi↔mobil veri geçen ya da taşıyıcı NAT'ı dönen dürüst kullanıcıyı
  cezalandırmaz. (Tam eşleşme, bu kullanıcılara sadece "authentication failed" gösteriyordu.)
- **Nonce deposu** — global ve IP başına tavanlı, en eskiden başlayarak boşaltılır;
  handshake seli belleği şişiremez.
- **HWID doğrulama** — charset + uzunluk kontrolü, `unknown`/`nil`/`0` gibi **placeholder
  HWID'ler reddedilir** (yoksa HWID toplayamayan her cihaz aynı key'i açardı), ilk bağlama
  **atomik** (iki cihaz aynı anda yarışıp ikisi birden giremez).
- **Çift kimlikli cihaz eşleştirme** — `RbxAnalyticsService:GetClientId()`'nin herkese açık
  spoofer'ları var; tek başına zayıf. Loader ayrıca executor'ın kendi dosya sistemine
  **rastgele bir cihaz token'ı** yazıyor: spoof'lanmış client id'yi ve oyunun yeniden
  kurulmasını atlatır, sadece workspace silinirse kaybolur. Eşleştirme kuralı bilinçli
  olarak asimetrik:
  - **çelişen** token → **reddet** (client id eşleşse bile — spoof'lanabilir olan taraf o)
  - **eksik** token (workspace silinmiş, dosya API'si yok) → client id'ye düş
  - `DEVICE_MATCH_REQUIRED=2` → ikisi de eşleşmek zorunda (yeniden kurulumu da kilitler)
- **Key-paylaşımı** — pencere içinde çok fazla farklı **HWID** (`KEY_SHARE_MAX_HWIDS`) veya
  çok fazla farklı **IP** (`KEY_SHARE_MAX_IPS`) gören key otomatik banlanır. Sadece
  _başarılı_ çalıştırmalar sayılır — key'i bilen biri rastgele HWID yağdırıp başkasının
  key'ini bandıramaz.
- **Key başına throttle** — `KEY_RATE_MAX` ile bir key'in pencere içindeki başarılı auth
  sayısı sınırlanır (ban yerine 429).
- **Executor kontrolü** — `BLOCKED_EXECUTORS` (denylist) ve `ALLOWED_EXECUTORS` (allowlist;
  doluysa sadece o executor'lar).

**İstemci tarafı (çıtayı yükseltir):**

- **Obfuscate loader** — `/loader/<id>.lua` her istekte byte-benzersiz, şifreli bir stub
  döner. Ortada patch'lenip yeniden dağıtılacak sabit bir metin yok.
- **Anti-hook** — iki kademeli. **Durdurur:** executor `iscclosure` ile `request` veya
  `loadstring`'in Lua closure olduğunu *açıkça* söylerse (payload'ı dump etmenin klasik
  yolu). **Sadece raporlar:** `JSONEncode`/`JSONDecode` ve `debug.info` kaynak çapraz
  kontrolü — bazı executor'lar bunları meşru olarak Lua ile sarmalıyor, o yüzden gerçek
  kullanıcıyı kilitlemek yerine dashboard'a düşer. Executor cevap veremiyorsa hiçbir
  kontrol kurcalanmış saymaz.
- **Bütünlük** — stub, çözülen kaynağın çift checksum'ını doğrular; bozulmuş payload çalışmaz.
- **Tamper raporu** — istemci tarafı bir kontrol patladığında `POST /api/v1/report` ile
  sunucuya haber verir; dashboard'da `client_tamper:*` olarak görünür. Yalnızca **bilgi
  amaçlı** — sahte rapor atılabileceği için varsayılan olarak hiçbir şeyi banlamaz
  (`TAMPER_REPORT_BAN` ile açılabilir).

Loader'ın SHA-256/HMAC'i saf Lua ([lua/sha256.lua](lua/sha256.lua)) — `bit32` varsa onu,
yoksa aritmetik fallback'i kullanır, yani her executor'da çalışır. Test paketi bu
implementasyonu Node'un `crypto`'suna karşı ~400 vektörle doğrular; ayrıca **gerçek loader
gerçek bir Lua VM'de** uçtan uca çalıştırılır ([test/loader.test.js](test/loader.test.js)).

**Ayarlar** (`.env`):

| Değişken                                    | Varsayılan     | Açıklama                                                                                                                         |
| ------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `ANTI_TAMPER`                               | `1`            | Ana anahtar. 0 = handshake/proof/oturum şifrelemesi kapalı (sadece debug)                                                        |
| `NONCE_TTL_MS`                              | `20000`        | Handshake ömrü                                                                                                                   |
| `NONCE_BIND_IP`                             | `1`            | Nonce'u handshake'i alan IP'ye bağla                                                                                             |
| `NONCE_MAX` / `NONCE_MAX_PER_IP`            | `50000` / `60` | Canlı handshake tavanları                                                                                                        |
| `REQUIRE_PROOF`                             | `1`            | HMAC proof'u zorunlu kıl                                                                                                         |
| `SESSION_ENCRYPTION`                        | `1`            | Payload'ı oturum anahtarıyla şifrele                                                                                             |
| `OBFUSCATE_LOADER`                          | `1`            | Loader bootstrap'ını da şifreli gönder                                                                                           |
| `TAMPER_REPORTS` / `TAMPER_REPORT_BAN`      | `1` / `0`      | İstemci raporlarını al / N rapordan sonra banla                                                                                  |
| `RISK_SCORING`                              | `1`            | Sinyalleri tek tek tetik yerine 0-100 skorda topla                                                                               |
| `RISK_WATCH_AT` / `RISK_BAN_AT`             | `45` / `85`    | Panelde işaretle / servis dışı bırak eşikleri                                                                                    |
| `ENV_PINNING`                               | `1`            | İlk kullanımda ortam parmak izini pinle, değişimleri say                                                                         |
| `DEVICE_MATCH_REQUIRED`                     | `1`            | Cihaz kimliğinin kaç tanesi eşleşmeli (2 = client id **ve** token)                                                               |
| `KEY_SHARE_MAX_HWIDS` / `KEY_SHARE_MAX_IPS` | `0` / `0`      | Eski tarz sert paylaşım oto-ban eşikleri (0 = kapalı, risk skoru bunun yerini alır)                                              |
| `KEY_SHARE_WINDOW_MS`                       | `3600000`      | Paylaşım/rapor penceresi                                                                                                         |
| `KEY_RATE_MAX` / `KEY_RATE_WINDOW_MS`       | `0` / `60000`  | Key başına auth throttle (0 = kapalı)                                                                                            |
| `HWID_MAX_LENGTH`                           | `128`          | Kabul edilen en uzun HWID                                                                                                        |
| `EXECUTIONS_RETENTION_DAYS`                 | `14`           | Ham execution satırı saklama süresi; eskiler günlük rollup'a katlanıp silinir (0 = hiç silme)                                    |
| `RETENTION_SWEEP_MS`                        | `3600000`      | Rollup/temizlik sıklığı                                                                                                          |
| `HEARTBEAT`                                 | `1`            | Canlı oturum (lease) + heartbeat                                                                                                 |
| `HEARTBEAT_INTERVAL_MS` / `LEASE_TTL_MS`    | `60000` / `210000` | Beat aralığı / lease ömrü (birkaç kaçan beat'i tolere edecek kadar uzun tut)                                                  |
| `LEASE_MAX_PER_KEY`                         | `1`            | Key başına eşzamanlı oturum — çok cihazlı satış için artır                                                                       |
| `LOADER_RATE_MAX` / `LOADER_RATE_WINDOW_MS` | `20` / `60000` | `/loader/<id>.lua` rate limit                                                                                                     |
| `TRUST_PROXY`                               | `1`            | Önündeki proxy sayısı — **doğrudan açıksan 0 yap**, yoksa istemci `X-Forwarded-For` uydurup rate limit'i ve IP bağlamayı atlatır |

> **Sınırlar (dürüstçe):** Bunlar statik dump'ı, replay'i ve payload paylaşımını ciddi
> şekilde zorlaştırır; **çalışan** bir executor'da script'i belleğinden çekmeye kararlı
> birini durdurmaz — bunun için bytecode-VM seviyesi obfuscation gerekir. İstemci
> tarafındaki her kontrol prensipte patch'lenebilir; asıl dayanak sunucu tarafındaki
> proof + oturum anahtarıdır. Ve hepsi **HTTPS** varsayar: TLS yoksa salt de payload da
> araya girenin eline geçer.

## Auth akışı

1. Bir script oluştur → `script_id` alırsın.
2. O script için key'ler üret.
3. Kullanıcıya loader snippet'ini ver:
   ```lua
   script_key = "2t1_XXXX-XXXX-XXXX-XXXX";
   loadstring(game:HttpGet("http://localhost:3000/loader/<script_id>.lua"))()
   ```
4. Çalıştırıldığında loader HWID toplar, `/api/v1/handshake`'e **key'in hash'ini** yollayıp
   **nonce + salt + server_proof** alır, **önce sunucuyu doğrular**, sonra proof'unu hesaplayıp
   `/api/v1/auth`'a POST atar; sunucu doğrularsa oturum anahtarıyla şifrelenmiş script'i
   imzalayarak döndürür, loader imzayı doğrulayıp anahtarı kendi türetip çalıştırır.

## API

### Public (loader kullanır)

| Method | Endpoint                | Açıklama                                                                             |
| ------ | ----------------------- | ------------------------------------------------------------------------------------ |
| `GET`  | `/loader/:scriptId.lua` | O script için Lua bootstrap'ı döndürür (şifreli, her istekte benzersiz)              |
| `POST` | `/api/v1/handshake`     | `{ script_id, kh }` → tek kullanımlık `{ nonce, salt, ttl, server_proof }`            |
| `POST` | `/api/v1/auth`          | `{ script_id, kh, hwid, executor, nonce, proof }` → doğrula & imzalı script döndür    |
| `POST` | `/api/v1/heartbeat`     | `{ lease, n, beat }` → oturumu canlı tut / iptal edildiyse `{ revoked: true }`        |
| `POST` | `/api/v1/report`        | `{ script_id, kh, hwid, executor, reason, nonce, proof }` → istemci tamper sinyali    |

### Admin (`Authorization: Bearer <ADMIN_API_KEY>`)

| Method   | Endpoint                                       | Açıklama                                                 |
| -------- | ---------------------------------------------- | -------------------------------------------------------- |
| `POST`   | `/api/v1/scripts`                              | Script oluştur `{ name, source?, version?, hwid_lock? }` |
| `GET`    | `/api/v1/scripts`                              | Tüm script'leri listele                                  |
| `GET`    | `/api/v1/scripts/:id`                          | Script detayı + loader snippet                           |
| `PATCH`  | `/api/v1/scripts/:id`                          | Güncelle (ör. yeni `source`)                             |
| `DELETE` | `/api/v1/scripts/:id`                          | Sil                                                      |
| `POST`   | `/api/v1/scripts/:id/keys`                     | Key üret `{ count?, expiresInDays?, note?, discordId? }` |
| `GET`    | `/api/v1/scripts/:id/keys`                     | Key'leri listele `?limit=&offset=`                       |
| `GET`    | `/api/v1/scripts/:id/stats`                    | İstatistik `?days=7`                                     |
| `GET`    | `/api/v1/keys/:value`                          | Key'i value ile getir                                    |
| `PATCH`  | `/api/v1/keys/:id`                             | Key güncelle `{ status, note, expires_at, ... }`         |
| `POST`   | `/api/v1/keys/:id/ban` \| `/unban` \| `/pause` | Durum kısayolları                                        |
| `POST`   | `/api/v1/keys/:id/reset-hwid`                  | HWID'i sıfırla                                           |
| `DELETE` | `/api/v1/keys/:id`                             | Key sil                                                  |

### Örnek: script oluştur + key üret

```bash
# script oluştur
curl -X POST http://localhost:3000/api/v1/scripts \
  -H "Authorization: Bearer <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"name":"My Hub","source":"print(\"hello\")","hwid_lock":true}'

# dönen id ile 10 adet 30 günlük key üret
curl -X POST http://localhost:3000/api/v1/scripts/<script_id>/keys \
  -H "Authorization: Bearer <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"count":10,"expiresInDays":30}'
```

## Proje yapısı

```
src/
  index.js              Express uygulaması + graceful shutdown
  config.js             .env okuma      validateConfig.js  startup doğrulama
  db/                   SQLite bağlantısı + schema.sql (+ migrations)
  middleware/           admin auth (Bearer/çerez), rate limit, logger, error
  services/             scripts, keys, auth, stats, admins, resellers, obfuscator,
                        nonce (handshake oturumları), bootstrap (loader render)
  routes/               loader (public API), dashboard (login), scripts, keys, resellers, reseller
  utils/                crypto (+ oturum proof/anahtar türetme), password (scrypt), session
public/                 dashboard arayüzü (index.html, styles.css, app.js, fonts/)
bot/                    Discord bot (index, commands, register, config, util, log)
lua/                    loader_template.lua, sha256.lua (saf Lua SHA-256/HMAC)
scripts/                seed.js, create-admin.js
test/                   node:test paketi (npm test) + helpers/roblox_shim.lua
deploy/                 nginx / systemd / setup.sh / env örneği  (bkz. DEPLOY.md)
Dockerfile, docker-compose.yml
```

## Geliştirme

```bash
npm test           # tüm testler (node:test)
npm run dev        # otomatik yeniden başlatan sunucu (node --watch)
npm run format     # Prettier ile biçimlendir
```

Test dosyaları:

| Dosya                                                                    | Kapsam                                                                                              |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `attacker.test.js`                                                       | **Saldırgan paketi** — her test bir saldırıyı oynar ve sistemin reddettiğini doğrular: düşman uç nokta, düz metne düşürme, imza soyma, tek byte çevirme, payload takası, replay, oturumlar arası taşıma |
| `risk.test.js`                                                           | Risk skoru, ortam pinleme, bulanık cihaz eşleştirme — ağırlıklı olarak **yanlış pozitif** senaryoları (ağ değiştiren telefon, tek router'daki ev, yeniden kurulum) |
| `lease.test.js` / `retention.test.js` / `net.test.js`                    | Canlı oturumlar & iptal / log rollup & saklama / ağ prefix eşleştirme                                |
| `api.test.js`                                                            | Gerçek Express uygulaması üzerinden HTTP: loader teslimi, handshake→proof→auth, replay reddi, rapor |
| `loader.test.js`                                                         | Gerçek loader bootstrap'ı bir Lua VM'de uçtan uca çalışır (anti-hook dahil)                         |
| `sha256.test.js`                                                         | Saf Lua SHA-256/HMAC ↔ Node `crypto` (her iki bit-op yolu)                                          |
| `antitamper.test.js`                                                     | Executor listeleri, HWID kuralları/atomik bağlama, paylaşım tespiti, throttle, raporlar             |
| `obfuscator.test.js`                                                     | Stub üretimi, oturum/inline anahtar modları, bütünlük kontrolü                                      |
| `auth / keys / crypto / password / session / resellers / nonce / config` | Çekirdek servisler                                                                                  |

## Üretim / Deploy

- **VPS + Cloudflare:** adım adım rehber → [DEPLOY.md](DEPLOY.md)
- **Docker:** `.env`'i doldur, `docker compose up -d --build` (yine nginx'i önüne koy).
- Üretimde app `HOST=127.0.0.1` ile sadece localhost dinler; `NODE_ENV=production` iken
  zayıf secret / `http` `BASE_URL` ile **açılmayı reddeder** (fail-fast).

## Güvenlik notları

- **HTTPS zorunlu (üretim):** oturum salt'ı ve teslim edilen script TLS olmadan araya
  girilerek okunabilir — bu durumda oturum anahtarlı teslimatın da bir anlamı kalmaz.
  nginx/Cloudflare arkasında HTTPS şart.
- **`TRUST_PROXY` doğru olmalı:** proxy sayısından büyük bir değer, istemcinin
  `X-Forwarded-For` uydurup rate limit'i ve nonce'un IP bağlamasını atlatmasına izin verir.
  Uygulamaya doğrudan erişilebiliyorsa `TRUST_PROXY=0`.
- **Obfuscation:** açık (script başına). Byte-seviyesi RC4 her zaman güvenli; AST minify
  parse edilemezse otomatik atlanır. Bytecode-VM seviyesi değildir.
- **İstemci kontrolleri tavsiye niteliğinde:** anti-hook ve tamper raporları patch'lenebilir;
  güvenliğin dayandığı yer sunucu tarafındaki proof + oturum anahtarıdır.
- **Postgres'e geçiş:** `services/*` sorguları izole; sadece `db/` katmanı değişir.

## Lisans

MIT
