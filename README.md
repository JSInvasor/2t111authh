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

- 🛡️ **Anti-tamper** — tek kullanımlık nonce handshake (replay engeli), loader bütünlük checksum'ı + anti-hook, executor allowlist, key-paylaşımı oto-ban
- 🔒 **Obfuscation** — teslim anında minify + her istekte RC4 şifreleme; script düz metin sızmaz
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
- ✅ **Test paketi** — `npm test` (auth, key, HWID, session, obfuscation — gerçek Lua VM ile), graceful shutdown, request logging
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

| Komut | Kim | Açıklama |
|---|---|---|
| `/getkey` | Whitelist | Key'ini alır (yoksa oluşturur), loader snippet'i ile |
| `/resethwid` | Herkes | Kendi HWID'ini sıfırlar (cooldown + limit uygulanır) |
| `/info` | Herkes | Key durumu (status, HWID, expiry, execution, reset sayısı) |
| `/generate <count> [days] [note]` | Admin | Toplu key üretir |
| `/lookup <key>` | Admin | Key detayını gösterir |
| `/ban <key>` / `/unban <key>` | Admin | Key'i banlar / açar |

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
2. **RC4 şifreleme** — her istekte **rastgele anahtar** ile. Her teslim byte-benzersizdir,
   statik dump/imza işe yaramaz.
3. **Lua çözücü stub** — base64 + RC4 çözüp `loadstring`'ler; değişken adları rastgele.

Çözücü stub yalnızca `string`, `table`, `bit32` (yoksa saf-Lua XOR fallback) ve
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

Loader artık iki adımlı çalışır: önce **handshake** ile tek kullanımlık **nonce** alır,
sonra bunu `/api/v1/auth`'a gönderir. Yakalanan bir auth isteği **tekrar oynatılamaz**
(nonce tek kullanımlık + ~20s ömürlü + script'e bağlı).

- **Bütünlük** — obfuscation stub'ı, çözülen kaynağın checksum'ını doğrular; bozulmuş/kurcalanmış payload çalışmaz.
- **Anti-hook** — loader `request`/`HttpGet`'in Lua hook'u ile değiştirilip değiştirilmediğine bakar (temkinli, yanlış-pozitif yapmaz).
- **Executor kontrolü** — `BLOCKED_EXECUTORS` (denylist) ve `ALLOWED_EXECUTORS` (allowlist; doluysa sadece o executor'lar).
- **Key-paylaşımı** — `KEY_SHARE_MAX_HWIDS` doluysa, pencere içinde çok fazla farklı HWID'den gelen key otomatik banlanır.

Ayarlar `.env`: `ANTI_TAMPER=1` (0 = kapat, debug için), `NONCE_TTL_MS`, `ALLOWED_EXECUTORS`,
`KEY_SHARE_MAX_HWIDS`, `KEY_SHARE_WINDOW_MS`.

## Auth akışı

1. Bir script oluştur → `script_id` alırsın.
2. O script için key'ler üret.
3. Kullanıcıya loader snippet'ini ver:
   ```lua
   script_key = "2t1_XXXX-XXXX-XXXX-XXXX";
   loadstring(game:HttpGet("http://localhost:3000/loader/<script_id>.lua"))()
   ```
4. Çalıştırıldığında loader HWID toplar, önce `/api/v1/handshake` ile **nonce** alır,
   sonra `/api/v1/auth`'a (nonce dahil) POST atar; sunucu doğrularsa korunan (şifreli)
   script'i döndürür ve `loadstring` ile çalıştırır.

## API

### Public (loader kullanır)

| Method | Endpoint | Açıklama |
|---|---|---|
| `GET`  | `/loader/:scriptId.lua` | O script için Lua bootstrap'ı döndürür |
| `POST` | `/api/v1/handshake` | `{ script_id }` → tek kullanımlık `nonce` döndürür |
| `POST` | `/api/v1/auth` | `{ script_id, key, hwid, executor, nonce }` → doğrula & script döndür |

### Admin (`Authorization: Bearer <ADMIN_API_KEY>`)

| Method | Endpoint | Açıklama |
|---|---|---|
| `POST`   | `/api/v1/scripts` | Script oluştur `{ name, source?, version?, hwid_lock? }` |
| `GET`    | `/api/v1/scripts` | Tüm script'leri listele |
| `GET`    | `/api/v1/scripts/:id` | Script detayı + loader snippet |
| `PATCH`  | `/api/v1/scripts/:id` | Güncelle (ör. yeni `source`) |
| `DELETE` | `/api/v1/scripts/:id` | Sil |
| `POST`   | `/api/v1/scripts/:id/keys` | Key üret `{ count?, expiresInDays?, note?, discordId? }` |
| `GET`    | `/api/v1/scripts/:id/keys` | Key'leri listele `?limit=&offset=` |
| `GET`    | `/api/v1/scripts/:id/stats` | İstatistik `?days=7` |
| `GET`    | `/api/v1/keys/:value` | Key'i value ile getir |
| `PATCH`  | `/api/v1/keys/:id` | Key güncelle `{ status, note, expires_at, ... }` |
| `POST`   | `/api/v1/keys/:id/ban` \| `/unban` \| `/pause` | Durum kısayolları |
| `POST`   | `/api/v1/keys/:id/reset-hwid` | HWID'i sıfırla |
| `DELETE` | `/api/v1/keys/:id` | Key sil |

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
  services/             scripts, keys, auth, stats, admins, resellers, obfuscator, nonce
  routes/               loader, dashboard (login), scripts, keys, resellers, reseller
  utils/                crypto, password (scrypt), session (imzalı çerez)
public/                 dashboard arayüzü (index.html, styles.css, app.js)
bot/                    Discord bot (index, commands, register, config, util, log)
lua/                    loader_template.lua
scripts/                seed.js, create-admin.js
test/                   node:test paketi (npm test)
deploy/                 nginx / systemd / setup.sh / env örneği  (bkz. DEPLOY.md)
Dockerfile, docker-compose.yml
```

## Geliştirme

```bash
npm test           # tüm testler (node:test) — auth, key, HWID, session, obfuscation (Lua VM)
npm run dev        # otomatik yeniden başlatan sunucu (node --watch)
npm run format     # Prettier ile biçimlendir
```

## Üretim / Deploy

- **VPS + Cloudflare:** adım adım rehber → [DEPLOY.md](DEPLOY.md)
- **Docker:** `.env`'i doldur, `docker compose up -d --build` (yine nginx'i önüne koy).
- Üretimde app `HOST=127.0.0.1` ile sadece localhost dinler; `NODE_ENV=production` iken
  zayıf secret / `http` `BASE_URL` ile **açılmayı reddeder** (fail-fast).

## Güvenlik notları

- **HTTPS zorunlu (üretim):** teslim edilen script TLS olmadan araya girilerek okunabilir. nginx/Cloudflare arkasında HTTPS şart.
- **Obfuscation:** açık (script başına). Byte-seviyesi RC4 her zaman güvenli; AST minify parse edilemezse otomatik atlanır. Bytecode-VM seviyesi değildir.
- **Postgres'e geçiş:** `services/*` sorguları izole; sadece `db/` katmanı değişir.

## Lisans

MIT
