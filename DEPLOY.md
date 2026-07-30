# 2t1auth — Üretim Kurulumu (2t1.online)

**Hedef mimari** (Cloudflare + Ubuntu VPS):

```
Tarayıcı / Executor ──HTTPS──▶ Cloudflare (edge, DDoS, cache)
                                   │  HTTPS (Full strict, Origin Cert)
                                   ▼
                          VPS 5.189.165.10
                          nginx :443  ──▶  node app :3000 (sadece 127.0.0.1)
                                              └─ SQLite (data/2t1auth.db)
```

- Domain: **2t1.online** (Cloudflare proxy AÇIK — turuncu bulut)
- TLS: **Cloudflare Origin Certificate** + SSL modu **Full (strict)**
- App yalnızca `127.0.0.1:3000` dinler; internete açık olan tek şey nginx (80/443).

> Tüm `sudo ...` komutları **VPS'te** çalışır. Windows'ta çalışacak birkaç komut ayrıca belirtildi.

---

## Adım 0 — Cloudflare DNS

Cloudflare paneli → **2t1.online** → **DNS → Records**. Şu iki kaydı ekle/güncelle
(varsa eski/yanlış A kayıtlarını sil):

| Type | Name | Content | Proxy |
|------|------|-----------------|--------------|
| A | `2t1.online` (`@`) | `5.189.165.10` | Proxied 🟠 |
| A | `www` | `5.189.165.10` | Proxied 🟠 |

## Adım 1 — Cloudflare Origin Certificate

1. **SSL/TLS → Origin Server → Create Certificate**
   - Private key type: RSA, Hostnames: `2t1.online, *.2t1.online` → **Create**
2. Açılan iki metni kaydet:
   - **Origin Certificate** → `2t1.online.pem`
   - **Private Key** → `2t1.online.key`
3. **SSL/TLS → Overview** → şifreleme modunu **Full (strict)** yap.
4. **SSL/TLS → Edge Certificates** → **Always Use HTTPS: On**.

Sertifikayı VPS'e koyacağız (Adım 4).

## Adım 2 — Kodu VPS'e gönder

**Windows'ta (Git Bash)** — proje klasöründen, `node_modules`/`.env`/`data` hariç bir arşiv yapıp gönder:

```bash
cd "/c/Users/efesa/OneDrive/Masaüstü/2t1auth"
tar --exclude=node_modules --exclude=data --exclude=.env --exclude=.git -czf /tmp/2t1auth.tar.gz .
scp /tmp/2t1auth.tar.gz root@5.189.165.10:/root/
```

**VPS'te** aç:

```bash
mkdir -p /opt/2t1auth
tar -xzf /root/2t1auth.tar.gz -C /opt/2t1auth
cd /opt/2t1auth
```

## Adım 3 — Otomatik kurulum (Node + nginx + ufw + systemd)

VPS'te tek script:

```bash
sudo bash /opt/2t1auth/deploy/setup.sh
```

Bu; Node 20'yi, nginx'i, ufw'yi kurar, `2t1auth` kullanıcısını oluşturur,
bağımlılıkları yükler, nginx site'ını ve systemd servisini bağlar, firewall'u açar.
(`.env`, sertifika ve admin adımları bilerek manueldir — aşağıda.)

## Adım 4 — Sertifika + .env + admin

**4a. Cloudflare Origin cert dosyalarını yerleştir:**

```bash
sudo mkdir -p /etc/ssl/cloudflare
sudo nano /etc/ssl/cloudflare/2t1.online.pem   # Origin Certificate'i yapıştır
sudo nano /etc/ssl/cloudflare/2t1.online.key   # Private Key'i yapıştır
sudo chmod 600 /etc/ssl/cloudflare/2t1.online.key
```

**4b. Üretim `.env`'i oluştur ve doldur:**

```bash
cd /opt/2t1auth
sudo -u 2t1auth cp deploy/env.production.example .env
# İki güçlü secret üret ve .env'e yapıştır (ADMIN_API_KEY, SESSION_SECRET):
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
sudo -u 2t1auth nano .env
```

`.env` içinde en az şunlar dolu olmalı: `BASE_URL=https://2t1.online`, `HOST=127.0.0.1`,
`ADMIN_API_KEY`, `SESSION_SECRET`, `DB_PATH=/opt/2t1auth/data/2t1auth.db`.

**4c. Dashboard admin hesabı oluştur:**

```bash
cd /opt/2t1auth
sudo -u 2t1auth npm run create-admin -- admin 'BURAYA_GUCLU_SIFRE'
```

## Adım 5 — Başlat ve doğrula

```bash
sudo nginx -t && sudo systemctl reload nginx
sudo systemctl restart 2t1auth
systemctl status 2t1auth --no-pager
```

Kontroller:

```bash
curl -s http://127.0.0.1:3000/health          # VPS'te: {"status":"ok",...}
curl -sI https://2t1.online/dashboard/ | head  # her yerden: 200
```

Tarayıcıda **https://2t1.online/dashboard/** → admin/şifre ile giriş yap. 🎉

Loader URL'lerin artık: `https://2t1.online/loader/<script_id>.lua`

---

## Opsiyonel

**Origin'i sadece Cloudflare'e aç** (IP'ni gizli tutar, direkt saldırıyı önler):

```bash
sudo bash /opt/2t1auth/deploy/cloudflare-ufw.sh
```

**Discord botunu servis olarak çalıştır** (`.env`'de DISCORD_* dolduysa):

```bash
cd /opt/2t1auth && sudo -u 2t1auth npm run bot:register
sudo cp deploy/systemd/2t1auth-bot.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now 2t1auth-bot
```

---

## Bakım

| İş | Komut |
|---|---|
| Logları izle | `journalctl -u 2t1auth -f` |
| Yeniden başlat | `sudo systemctl restart 2t1auth` |
| Durum | `systemctl status 2t1auth` |
| Kod güncelle | Adım 2'yi tekrarla → `cd /opt/2t1auth && sudo -u 2t1auth npm install --omit=dev` → `sudo systemctl restart 2t1auth` |
| Dashboard eskimiş görünürse | Cloudflare → Caching → **Purge Everything** |

**Yedekleme:** tek dosya — `/opt/2t1auth/data/2t1auth.db` (WAL modunda; `.db`, `.db-wal`, `.db-shm` üçünü birlikte kopyala veya `sqlite3 ... ".backup"` kullan).

## Sorun giderme

- **502 Bad Gateway** → app çalışmıyor. `systemctl status 2t1auth`, `journalctl -u 2t1auth -e`.
- **525/526 (Cloudflare)** → origin TLS sorunu. Cert dosyaları doğru mu, SSL modu **Full (strict)** mi?
- **Sonsuz yönlendirme** → Cloudflare SSL modu **Flexible** olmasın (Full strict olmalı).
- **Giriş yapılamıyor / cookie tutmuyor** → `BASE_URL` `https://...` ile başlamalı (Secure cookie bunu gerektirir).
- **`better-sqlite3` hatası** → `sudo -u 2t1auth npm install --omit=dev` tekrar; Node 20 kurulu mu (`node -v`)?
