#!/bin/bash
# One-time setup, run as root on the Titan server:
#   bash /opt/titan/deploy/offsite-setup.sh 147.93.87.110
# 1. Lets this server copy backups to the other server over SSH (asks once for the other server's root password).
# 2. Installs the outside monitor on the other server, so you hear about it if this whole server goes down.
# 3. Runs a backup now and checks the copy arrived.
set -u
OTHER=${1:-147.93.87.110}
KEY=/root/.ssh/titan_offsite
REMOTE_DIR=/var/backups/titan-offsite
cd /opt/titan
echo "== Off-site backups and outside monitoring via $OTHER"
mkdir -p /root/.ssh && chmod 700 /root/.ssh
[ -f $KEY ] || ssh-keygen -q -t ed25519 -N '' -C "titan-offsite@$(hostname)" -f $KEY
SSH="ssh -i $KEY -o BatchMode=yes -o ConnectTimeout=20 -o StrictHostKeyChecking=accept-new"
if ! $SSH root@$OTHER true 2>/dev/null; then
  echo "Enter the root password of $OTHER when asked (only this once):"
  ssh-copy-id -i $KEY.pub -o StrictHostKeyChecking=accept-new root@$OTHER >/dev/null || { echo "STOP: could not add the key on $OTHER. Is root password login allowed there?"; exit 1; }
fi
$SSH root@$OTHER "mkdir -p $REMOTE_DIR && chmod 700 $REMOTE_DIR" && echo "OK  SSH key works; copies go to $OTHER:$REMOTE_DIR"
command -v rsync >/dev/null || apt-get install -y rsync >/dev/null 2>&1
$SSH root@$OTHER "command -v rsync >/dev/null || apt-get install -y rsync >/dev/null 2>&1"
cat > /etc/titan-offsite.conf <<CONF
OFFSITE_HOST=root@$OTHER
OFFSITE_DIR=$REMOTE_DIR
OFFSITE_KEY=$KEY
CONF
chmod 600 /etc/titan-offsite.conf

# Outside monitor on the other server: every 5 minutes, alerts by email if Titan or its MQTT port stops answering.
RESEND=$(grep '^RESEND_API_KEY=' .env | cut -d= -f2- | tr -d '"')
FROM=$(grep '^RESEND_FROM=' .env | cut -d= -f2- | tr -d '"')
TO=$(grep '^MONITOR_EMAILS=' .env | cut -d= -f2- | tr -d '"' | cut -d, -f1)
$SSH root@$OTHER "mkdir -p /opt/titan-monitor" && scp -q -i $KEY -o BatchMode=yes deploy/remote-monitor.sh root@$OTHER:/opt/titan-monitor/remote-monitor.sh
$SSH root@$OTHER "chmod 700 /opt/titan-monitor/remote-monitor.sh && cat > /etc/cron.d/titan-monitor && chmod 600 /etc/cron.d/titan-monitor" <<CRON
# Checks titan.kitovu.com.ng from outside every 5 minutes (installed from srv878622 by offsite-setup.sh)
*/5 * * * * root RESEND_API_KEY='$RESEND' RESEND_FROM='${FROM:-Titan monitor <alerts@titan.kitovu.com.ng>}' MONITOR_EMAILS='${TO:-titan@kitovu.com.ng}' /opt/titan-monitor/remote-monitor.sh
CRON
echo "OK  outside monitor installed on $OTHER (every 5 minutes)"
[ -n "$RESEND" ] || echo "NOTE: no Resend key yet, so the monitor can't send email. Run deploy/set-keys.sh, then this script again."

# Backup now and confirm the copy.
install -m 755 deploy/backup.sh /etc/cron.daily/titan-backup
/etc/cron.daily/titan-backup
echo "LOCAL:  $(ls /var/backups/titan | grep -c -E 'dump|tar.gz') files"
echo "REMOTE: $($SSH root@$OTHER "ls $REMOTE_DIR | wc -l") files on $OTHER"
echo "STATUS: $(cat /var/backups/titan/offsite-status 2>/dev/null)"
echo "MONITOR TEST: $($SSH root@$OTHER "/opt/titan-monitor/remote-monitor.sh; cat /tmp/titan-remote-monitor.state")"
