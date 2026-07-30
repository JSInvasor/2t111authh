#!/usr/bin/env bash
# Optional hardening: only allow Cloudflare's IPs to reach ports 80/443.
# This stops attackers from hitting your origin IP directly to bypass Cloudflare.
# Run as root AFTER setup.sh and AFTER confirming the site works.
#   sudo bash /opt/2t1auth/deploy/cloudflare-ufw.sh
#
# NOTE: keep OpenSSH open (this script does not touch SSH). If you ever move the
# domain off Cloudflare (grey cloud), re-open 80/443 to everyone.

set -euo pipefail

echo "==> Removing broad Nginx Full allow (if present)"
ufw delete allow 'Nginx Full' >/dev/null 2>&1 || true

echo "==> Allowing 80/443 only from Cloudflare IPv4 ranges"
for cidr in \
  173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 \
  141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 \
  197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 \
  104.24.0.0/14 172.64.0.0/13 131.0.72.0/22; do
  ufw allow from "$cidr" to any port 80 proto tcp >/dev/null
  ufw allow from "$cidr" to any port 443 proto tcp >/dev/null
done

ufw reload
echo "==> Done. Ports 80/443 are now Cloudflare-only. (SSH untouched.)"
echo "    Verify you can still load https://2t1.online through Cloudflare."
