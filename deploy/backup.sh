#!/bin/sh
# Daily Titan backup: database dump plus settings. Keeps 14 days in /var/backups/titan.
# If /etc/titan-offsite.conf exists (made by deploy/offsite-setup.sh), copies the backups to the other server too.
# Installed as /etc/cron.daily/titan-backup by deploy/upgrade.sh.
set -e
DIR=/var/backups/titan
mkdir -p $DIR && chmod 750 $DIR
STAMP=$(date +%Y-%m-%d)
DB=$(grep '^DATABASE_URL=' /opt/titan/.env | cut -d= -f2-)
pg_dump --format=custom --file=$DIR/titan-$STAMP.dump "$DB"
# Settings, passwords and Titan's firmware signing key + firmware files (losing the key means devices reject new updates).
tar -czf $DIR/settings-$STAMP.tar.gz -C / opt/titan/.env opt/titan/data etc/emqx/emqx.conf root/emqx-admin-password.txt root/titan-db-password.txt 2>/dev/null || true
chmod 640 $DIR/titan-$STAMP.dump $DIR/settings-$STAMP.tar.gz
find $DIR -type f \( -name '*.dump' -o -name '*.tar.gz' \) -mtime +14 -delete

# Off-site copy (keeps 30 days there).
if [ -f /etc/titan-offsite.conf ]; then
  . /etc/titan-offsite.conf
  SSH="ssh -i $OFFSITE_KEY -o BatchMode=yes -o ConnectTimeout=20"
  if rsync -az -e "$SSH" $DIR/titan-$STAMP.dump $DIR/settings-$STAMP.tar.gz "$OFFSITE_HOST:$OFFSITE_DIR/" \
     && $SSH "$OFFSITE_HOST" "find '$OFFSITE_DIR' -type f -mtime +30 -delete"; then
    echo "ok $(date -u +%FT%TZ) $OFFSITE_HOST" > $DIR/offsite-status
  else
    echo "failed $(date -u +%FT%TZ) $OFFSITE_HOST" > $DIR/offsite-status
  fi
  chmod 644 $DIR/offsite-status
fi
