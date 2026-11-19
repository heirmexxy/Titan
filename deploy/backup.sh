#!/bin/sh
# Daily Titan backup: database dump plus settings. Keeps 14 days in /var/backups/titan.
# Installed as /etc/cron.daily/titan-backup by: install -m 755 deploy/backup.sh /etc/cron.daily/titan-backup
set -e
DIR=/var/backups/titan
mkdir -p $DIR && chmod 700 $DIR
STAMP=$(date +%Y-%m-%d)
DB=$(grep '^DATABASE_URL=' /opt/titan/.env | cut -d= -f2-)
pg_dump --format=custom --file=$DIR/titan-$STAMP.dump "$DB"
# Settings, passwords and Titan's firmware signing key + firmware files (losing the key means devices reject new updates).
tar -czf $DIR/settings-$STAMP.tar.gz -C / opt/titan/.env opt/titan/data etc/emqx/emqx.conf root/emqx-admin-password.txt root/titan-db-password.txt 2>/dev/null || true
find $DIR -type f -mtime +14 -delete
