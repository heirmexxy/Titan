#!/bin/bash
# Updates Titan on the server to the latest code on GitHub. Run as root from anywhere:
#   bash /opt/titan/deploy/upgrade.sh
set -u
cd /opt/titan
echo "== Updating Titan"
sudo -u titan git fetch -q origin && sudo -u titan git reset -q --hard origin/main && echo "OK  code: $(git log -1 --format='%h %s' | cut -c1-70)"
sudo -u titan npm install --no-audit --no-fund >/dev/null 2>&1 && echo "OK  packages"
sudo -u titan npm run -s build && echo "OK  build" || { echo "STOP: build failed"; exit 1; }
sudo -u titan npm run -s migrate 2>&1 | tail -3
mkdir -p /opt/titan/data && chown titan:titan /opt/titan/data && chmod 700 /opt/titan/data
grep -q '^DATA_DIR=' .env || echo 'DATA_DIR=/opt/titan/data' >> .env
grep -q '^BACKUP_DIR=' .env || echo 'BACKUP_DIR=/var/backups/titan' >> .env
grep -q '^MONITOR_EMAILS=' .env || echo 'MONITOR_EMAILS=titan@kitovu.com.ng' >> .env
# Titan reads the backup folder for the health page.
mkdir -p /var/backups/titan && chmod 750 /var/backups/titan && chgrp titan /var/backups/titan
install -m 755 deploy/backup.sh /etc/cron.daily/titan-backup
# Watchdog: checks every minute, restarts what stopped, emails/texts on trouble.
cp deploy/titan-watchdog.service deploy/titan-watchdog.timer /etc/systemd/system/
systemctl daemon-reload && systemctl enable -q --now titan-watchdog.timer && echo "OK  watchdog every minute"
systemctl restart titan; sleep 4
echo "TITAN: $(systemctl is-active titan)"
curl -s http://127.0.0.1:4600/healthz/deep | python3 -c 'import json,sys; h=json.load(sys.stdin); print("HEALTH:", "ok" if h["ok"] else "attention"); [print("  ", "ok " if c["ok"] else "!! ", c["name"]) for c in h["checks"]]'
