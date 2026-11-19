#!/bin/sh
# Off-server check for Titan. Run from a DIFFERENT server (e.g. srv746534) every 5 minutes:
#   */5 * * * * RESEND_API_KEY=re_xxx MONITOR_EMAILS=titan@kitovu.com.ng /opt/titan-monitor/remote-monitor.sh
# It alerts when titan.kitovu.com.ng or the MQTT port stops answering, which the on-server watchdog
# cannot report if the whole server is down. Needs curl and openssl.
URL=${TITAN_URL:-https://titan.kitovu.com.ng}
MQTT=${TITAN_MQTT:-mqtt.titan.kitovu.com.ng:8883}
STATE=${STATE_FILE:-/tmp/titan-remote-monitor.state}
TO=${MONITOR_EMAILS:-titan@kitovu.com.ng}
problems=""
code=$(curl -s -o /dev/null -w '%{http_code}' -m 20 "$URL/healthz/deep")
[ "$code" = "200" ] || problems="$problems web health answered ${code:-nothing};"
echo | timeout 10 openssl s_client -connect "$MQTT" -servername "${MQTT%:*}" >/dev/null 2>&1 || problems="$problems MQTT TLS port not answering;"
prev=$(cat "$STATE" 2>/dev/null)
send() {
  [ -n "$RESEND_API_KEY" ] || return
  curl -s -m 20 https://api.resend.com/emails -H "Authorization: Bearer $RESEND_API_KEY" -H 'Content-Type: application/json' \
    -d "{\"from\":\"${RESEND_FROM:-Titan monitor <alerts@titan.kitovu.com.ng>}\",\"to\":[\"$TO\"],\"subject\":\"$1\",\"text\":\"$2\"}" >/dev/null
}
if [ -n "$problems" ]; then
  # Alert on the second failed check in a row, so a single blip does not page anyone.
  case "$prev" in bad1) send "Titan is unreachable from outside" "$problems Checked from $(hostname)."; echo bad2 > "$STATE";; bad2) ;; *) echo bad1 > "$STATE";; esac
else
  [ "$prev" = "bad2" ] && send "Titan is reachable again" "All outside checks pass. Checked from $(hostname)."
  echo ok > "$STATE"
fi
