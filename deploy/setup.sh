#!/usr/bin/env bash
# 2t1auth — Ubuntu provisioning script.
# Run as root ON THE VPS, after the code is already in /opt/2t1auth.
#   sudo bash /opt/2t1auth/deploy/setup.sh
#
# It installs Node 20 + nginx + ufw, creates the service user, installs deps,
# and wires up nginx + systemd. It does NOT touch DNS, the Cloudflare cert,
# or your .env — those steps are manual (see DEPLOY.md).

set -euo pipefail

APP_DIR=/opt/2t1auth
APP_USER=2t1auth

echo "==> [1/7] apt update + base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg build-essential nginx ufw

echo "==> [2/7] Node.js 20 LTS (NodeSource)"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "==> [3/7] service user '$APP_USER'"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"

echo "==> [4/7] install dependencies"
cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund
mkdir -p "$APP_DIR/data"
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

echo "==> [5/7] nginx site"
cp "$APP_DIR/deploy/nginx/2t1.online.conf" /etc/nginx/sites-available/2t1.online
ln -sf /etc/nginx/sites-available/2t1.online /etc/nginx/sites-enabled/2t1.online
rm -f /etc/nginx/sites-enabled/default
mkdir -p /etc/ssl/cloudflare
echo "    (place your Cloudflare Origin cert at /etc/ssl/cloudflare/2t1.online.pem and .key)"

echo "==> [6/7] systemd service"
cp "$APP_DIR/deploy/systemd/2t1auth.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable 2t1auth

echo "==> [7/7] firewall (ufw)"
ufw allow OpenSSH >/dev/null || true
ufw allow 'Nginx Full' >/dev/null || true
yes | ufw enable >/dev/null || true

cat <<'DONE'

==================== base setup complete ====================
Remaining MANUAL steps (see DEPLOY.md for details):

  1. Create /opt/2t1auth/.env  (copy deploy/env.production.example, fill secrets)
       sudo -u 2t1auth cp deploy/env.production.example .env
       # generate secrets:
       node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
       sudo -u 2t1auth nano .env

  2. Put the Cloudflare Origin cert + key at:
       /etc/ssl/cloudflare/2t1.online.pem
       /etc/ssl/cloudflare/2t1.online.key

  3. Create a dashboard admin:
       cd /opt/2t1auth && sudo -u 2t1auth npm run create-admin -- admin 'STRONG_PASSWORD'

  4. Start everything:
       sudo nginx -t && sudo systemctl reload nginx
       sudo systemctl restart 2t1auth
       systemctl status 2t1auth --no-pager

  Then open  https://2t1.online/dashboard/
=============================================================
DONE
