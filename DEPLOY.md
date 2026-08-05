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
- VPS'e SSH kullanıcısı: **`dbg`** (sudo yetkili). Servis, ayrı ve giriş yapamayan
  bir `2t1auth` sistem kullanıcısı olarak çalışır — `dbg` değil.

> `sudo ...` ile başlayan her komut **VPS'te**, `dbg` olarak çalışır.
> Windows'ta çalışacak olanlar ayrıca belirtildi.

---

## Adım 0 — Başlamadan önce

**0a. `dbg` sudo yetkili mi?**

```bash
ssh dbg@5.189.165.10
sudo -v && echo "sudo tamam"
```

Hata verirse, root olarak bir kez: `usermod -aG sudo dbg`

**0b. SSH portun 22 değilse önce onu firewall'a ekle.**

Adım 4'teki script `ufw`'yi açar ve yalnızca OpenSSH (22) + nginx'e izin verir.
Özel bir port kullanıyorsan **script'ten önce** şunu çalıştır, yoksa bağlantın kopar:

```bash
ss -tlnp | grep sshd            # hangi porttan dinliyor
sudo ufw allow <PORTUN>/tcp     # örn. sudo ufw allow 2222/tcp
```

---

## Adım 1 — Eski kurulumu temizle

> **Bu adım veri siler.** `/opt/2t1auth/data/2t1auth.db` içindeki her şey —
> script'ler, key'ler, bayiler, çalıştırma geçmişi — bu tek dosyada. Silersen
> dağıttığın key'ler çalışmaz olur. Önce yedek al.

**1a. Yedek (eski kurulum varsa):**

```bash
sudo tar -czf ~/2t1auth-yedek-$(date +%F-%H%M).tar.gz \
  -C /opt/2t1auth data .env 2>/dev/null \
  && echo "yedek alındı: ~/2t1auth-yedek-*.tar.gz" \
  || echo "(eski kurulum yok — atla)"
```

**1b. Servisleri durdur ve her şeyi kaldır:**

```bash
sudo systemctl disable --now 2t1auth 2t1auth-bot 2>/dev/null || true
sudo rm -f /etc/systemd/system/2t1auth.service /etc/systemd/system/2t1auth-bot.service
sudo systemctl daemon-reload
sudo rm -f /etc/nginx/sites-enabled/2t1.online /etc/nginx/sites-available/2t1.online
sudo rm -rf /opt/2t1auth
rm -f ~/2t1auth.tar.gz
```

Kontrol — ikisi de boş dönmeli:

```bash
systemctl list-units --all | grep 2t1auth
ls /opt/2t1auth 2>/dev/null
```

> **Veritabanını korumak istiyorsan** `sudo rm -rf /opt/2t1auth` yerine
> `data/` ve `.env` dışındaki her şeyi sil — böylece Adım 5'i atlayabilirsin:
>
> ```bash
> cd /opt/2t1auth
> sudo find . -maxdepth 1 -mindepth 1 ! -name data ! -name .env -exec rm -rf {} +
> ls -a          # sadece . .. data .env kalmalı
> ```

---

## Adım 2 — Cloudflare DNS + Origin Certificate

**2a. DNS.** Cloudflare paneli → **2t1.online** → **DNS → Records**. Şu iki kaydı
ekle/güncelle (varsa eski veya yanlış A kayıtlarını sil):

| Type | Name | Content | Proxy |
|------|------|-----------------|--------------|
| A | `2t1.online` (`@`) | `5.189.165.10` | Proxied 🟠 |
| A | `www` | `5.189.165.10` | Proxied 🟠 |

**2b. Sertifika.**

1. **SSL/TLS → Origin Server → Create Certificate**
   - Private key type: RSA, Hostnames: `2t1.online, *.2t1.online` → **Create**
2. Açılan iki metni bir yere kopyala — sayfayı kapatınca private key bir daha
   gösterilmez:
   - **Origin Certificate** → Adım 5'te `.pem` olarak yapıştıracaksın
   - **Private Key** → Adım 5'te `.key` olarak yapıştıracaksın
3. **SSL/TLS → Overview** → şifreleme modu **Full (strict)**
4. **SSL/TLS → Edge Certificates** → **Always Use HTTPS: On**

---

## Adım 3 — Kodu VPS'e getir

Depo herkese açık, yani kodu doğrudan VPS'te çekebilirsin — bilgisayarındaki
klasöre hiç dokunmana gerek yok, tar/scp yok, şifre sorulmaz.

> **Branch'e dikkat.** Arayüz çalışmasının tamamı
> `claude/kanka-anti-tamper-dev-74egn7` branch'inde; `main` bunun epey gerisinde.
> `-b` bayrağını atlarsan VPS'e eski arayüz iner.

```bash
sudo apt-get install -y git
sudo git clone -b claude/kanka-anti-tamper-dev-74egn7 \
  https://github.com/JSInvasor/2t111authh.git /opt/2t1auth

cd /opt/2t1auth
git log --oneline -1                 # en son commit
ls public/fonts                      # 4 adet .woff2 → yeni arayüz geldi demektir
```

<details>
<summary>Alternatif: kendi klasöründen göndermek istersen (tar + scp)</summary>

Yalnızca bilgisayarındaki klasörde GitHub'a gönderilmemiş bir şey varsa gerekir.
Windows 10/11'de `tar` ve `scp` hazır gelir, Git Bash şart değil — klasöre
Shift + sağ tık → "PowerShell penceresini burada aç":

```powershell
tar --exclude=node_modules --exclude=data --exclude=.env --exclude=.git `
    -czf "$env:TEMP\2t1auth.tar.gz" .
scp "$env:TEMP\2t1auth.tar.gz" dbg@5.189.165.10:~/
```

VPS'te:

```bash
sudo mkdir -p /opt/2t1auth
sudo tar -xzf ~/2t1auth.tar.gz -C /opt/2t1auth
ls /opt/2t1auth/public/fonts
```

</details>

---

## Adım 4 — Otomatik kurulum

```bash
sudo bash /opt/2t1auth/deploy/setup.sh
```

Bu script: Node 20 + nginx + ufw + derleme araçlarını kurar, `2t1auth` servis
kullanıcısını oluşturur, bağımlılıkları yükler (`npm install --omit=dev`),
nginx site'ını ve systemd servisini bağlar, firewall'u açar.

Sertifika, `.env` ve admin adımları bilerek manuel — sırada onlar var.

---

## Adım 5 — Sertifika + .env + admin

**5a. Cloudflare Origin cert'ini yerleştir** (Adım 2b'de kopyaladıkların):

```bash
sudo mkdir -p /etc/ssl/cloudflare
sudo nano /etc/ssl/cloudflare/2t1.online.pem     # Origin Certificate
sudo nano /etc/ssl/cloudflare/2t1.online.key     # Private Key
sudo chown root:root /etc/ssl/cloudflare/2t1.online.*
sudo chmod 600 /etc/ssl/cloudflare/2t1.online.key
```

**5b. İki secret üret** (çıktıları bir yere al, birazdan yapıştıracaksın):

```bash
echo "ADMIN_API_KEY=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
echo "SESSION_SECRET=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
```

**5c. `.env`'i oluştur:**

```bash
cd /opt/2t1auth
sudo -u 2t1auth cp deploy/env.production.example .env
sudo -u 2t1auth nano .env
```

Şu satırlar dolu olmalı — gerisi varsayılanlarıyla doğru:

```
PORT=3000
HOST=127.0.0.1
BASE_URL=https://2t1.online
ADMIN_API_KEY=<5b'deki ilk değer>
SESSION_SECRET=<5b'deki ikinci değer>
DB_PATH=/opt/2t1auth/data/2t1auth.db
TRUST_PROXY=1
```

> `BASE_URL` **https** ile başlamak zorunda. Oturum çerezi `Secure` bayrağını
> buradan alıyor; `http` yazarsan tarayıcı çerezi tutmaz ve giriş yapılamaz.

**5d. Dashboard admin hesabı:**

```bash
cd /opt/2t1auth
sudo -u 2t1auth node scripts/create-admin.js admin 'BURAYA_GUCLU_SIFRE'
```

---

## Adım 6 — Başlat ve doğrula

```bash
sudo nginx -t && sudo systemctl reload nginx
sudo systemctl restart 2t1auth
systemctl status 2t1auth --no-pager
```

Sırayla kontrol et:

```bash
# 1) app ayakta mı (VPS'te)
curl -s http://127.0.0.1:3000/health
#    → {"status":"ok","uptime":...}

# 2) nginx + Cloudflare zinciri (her yerden)
curl -sI https://2t1.online/dashboard/ | head -1
#    → HTTP/2 200

# 3) yeni arayüz gerçekten gitmiş mi
curl -s https://2t1.online/dashboard/ | grep -c 'class="shelf"'
#    → 1
curl -sI https://2t1.online/dashboard/fonts/quicksand-latin.woff2 | head -1
#    → HTTP/2 200
```

Tarayıcıda **https://2t1.online/dashboard/** → admin + şifren ile giriş. 🎉

Loader URL'lerin: `https://2t1.online/loader/<script_id>.lua`

---

## Opsiyonel

**Origin'i sadece Cloudflare'e aç** (IP'ni gizler, doğrudan saldırıyı keser):

```bash
sudo bash /opt/2t1auth/deploy/cloudflare-ufw.sh
```

**Discord botu** (`.env`'de `DISCORD_*` doluysa):

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
| Dashboard eskimiş görünürse | Cloudflare → Caching → **Purge Everything** |

**Kod güncelleme** (veriye dokunmadan). `data/` ve `.env` git tarafından
yok sayıldığı için `pull` onlara dokunmaz:

```bash
cd /opt/2t1auth
sudo systemctl stop 2t1auth
sudo -u 2t1auth git pull            # servis kullanıcısı olarak — dosyaların sahibi o
sudo -u 2t1auth npm install --omit=dev
sudo systemctl start 2t1auth
```

> `sudo git pull` (yani root olarak) yerine `sudo -u 2t1auth` kullanmamızın
> sebebi: klasör `2t1auth` kullanıcısına ait, root'un başkasına ait bir depoda
> git çalıştırması `detected dubious ownership` hatası verir.

**Yedekleme** — tek dosya: `/opt/2t1auth/data/2t1auth.db`. WAL modunda olduğu
için `.db`, `.db-wal`, `.db-shm` üçünü birlikte kopyala:

```bash
sudo tar -czf ~/2t1auth-yedek-$(date +%F).tar.gz -C /opt/2t1auth data
```

## Sorun giderme

- **502 Bad Gateway** → app çalışmıyor. `systemctl status 2t1auth`, `journalctl -u 2t1auth -e`.
- **525 / 526 (Cloudflare)** → origin TLS sorunu. Cert dosyaları doğru mu, SSL modu **Full (strict)** mi?
- **Sonsuz yönlendirme** → Cloudflare SSL modu **Flexible** olmasın; Full (strict) olacak.
- **Giriş yapılamıyor / çerez tutmuyor** → `.env`'de `BASE_URL` `https://` ile başlamalı.
- **Fontlar/arayüz eski** → yanlış branch'ten arşiv gitmiş. Adım 3'ü `git checkout` ile tekrarla, sonra Cloudflare cache'ini purge et.
- **`better-sqlite3` derleme hatası** → `node -v` 20 mi? Değilse `sudo bash deploy/setup.sh` tekrar; `build-essential` gerekli.
- **SSH kesildi** → ufw özel SSH portuna izin vermemiş. Sağlayıcının konsolundan gir, `sudo ufw allow <PORT>/tcp`.

### 443 portu başka bir servise ait

Sunucuda zaten 443'ü tutan bir şey varsa (`sudo ss -tlnp | grep :443` kimin
tuttuğunu söyler) nginx o porta bağlanamaz, `reload` sessizce eski config'le
kalır ve Cloudflare **526** döner — çünkü karşısında bizim sertifikamız değil,
o servisin sertifikası vardır. Bunu şöyle görürsün:

```bash
sudo openssl s_client -connect 127.0.0.1:443 -servername 2t1.online </dev/null 2>/dev/null \
  | openssl x509 -noout -issuer -subject
```

İki servis de kalacaksa nginx'i Cloudflare'in origin için kabul ettiği başka bir
HTTPS portuna al — **2053, 2083, 2087, 2096, 8443** — ve Cloudflare'de bir Origin
Rule ile oraya yönlendir. Ziyaretçi yine normal `https://2t1.online` kullanır.

```bash
# 1) portun boş olduğunu doğrula
sudo ss -tlnp | grep :8443 || echo "8443 boş"

# 2) nginx'i o porta al (sites-available olanı düzenle, sites-enabled symlink)
sudo sed -i -e 's/^\(\s*listen \)443\( ssl.*\)$/\18443\2/' \
            -e 's/^\(\s*listen \[::\]:\)443\( ssl.*\)$/\18443\2/' \
            /etc/nginx/sites-available/2t1.online

sudo ufw allow 8443/tcp
sudo nginx -t && sudo systemctl reload nginx

# 3) doğrula — kendi sertifikamız çıkmalı ve app'e ulaşmalı
sudo openssl s_client -connect 127.0.0.1:8443 -servername 2t1.online </dev/null 2>/dev/null \
  | openssl x509 -noout -issuer
curl -sk https://127.0.0.1:8443/dashboard/ -H 'Host: 2t1.online' -o /dev/null -w "%{http_code}\n"
```

Sonra Cloudflare panelinde: **Rules → Origin Rules → Create rule** → eşleşme
"All incoming requests" → **Destination Port: Rewrite to `8443`** → Deploy.

> Bu değişiklik `/etc/nginx/` içinde yaşıyor, depoda değil. `deploy/nginx/…conf`
> dosyasını sunucuya tekrar kopyalarsan port 443'e geri döner — kopyaladıysan
> yukarıdaki `sed`'i tekrar çalıştır.

### `NODE_MODULE_VERSION` uyuşmazlığı

```
The module … better_sqlite3.node was compiled against a different Node.js version
using NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 115.
```

Sunucuda birden fazla Node var: `npm install` biriyle derlemiş, systemd
başkasıyla çalıştırıyor. `setup.sh` mevcut Node 18+ ise kendi kurulumunu
atladığı için bu ikilik fark edilmeden kalabiliyor. (127 = Node 22, 115 = Node
20.) Önce hangi ikilinin ne olduğuna bak:

```bash
which -a node npm
/usr/bin/node -p "process.versions.modules"
/usr/local/bin/node -p "process.versions.modules"   # varsa
```

Modülün hangisi için derlendiğini şöyle bulursun — hangisi `OK` yazarsa o:

```bash
sudo -u 2t1auth /usr/bin/node       -e "require('/opt/2t1auth/node_modules/better-sqlite3');console.log('OK')"
sudo -u 2t1auth /usr/local/bin/node -e "require('/opt/2t1auth/node_modules/better-sqlite3');console.log('OK')"
```

Servisi o Node'a geçir — modülü yeniden derlemekten daha sağlam, çünkü `npm`
zaten `#!/usr/bin/env node` ile PATH'teki ilk Node'u kullanıyor:

```bash
sudo sed -i 's|^ExecStart=.*node |ExecStart=/usr/local/bin/node |' /etc/systemd/system/2t1auth.service
sudo systemctl daemon-reload && sudo systemctl restart 2t1auth
```

> Depodaki unit dosyaları artık `ExecStart=/usr/bin/env node` kullanıyor, yani
> npm ile aynı Node'u seçiyor. Bu düzeltme yalnızca eski bir kurulumdan kalan
> `/etc/systemd/system/2t1auth.service` için gerekli.
