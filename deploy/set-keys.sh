#!/bin/bash
# Prompts for Titan's outside-service keys and saves them in /opt/titan/.env, then restarts Titan.
# Keys are typed or pasted at hidden prompts, so they never appear on screen or in shell history.
# Press Enter on any prompt to keep the current value.
set -u
ENV=/opt/titan/.env
setv() {  # setv NAME VALUE
  local v=$2
  case "$v" in *' '*|*'<'*|*'>'*) v="\"$v\"";; esac
  if grep -q "^$1=" $ENV; then
    python3 - "$ENV" "$1" "$v" <<'PY'
import re, sys
p, k, v = sys.argv[1:]
s = open(p).read()
s = re.sub(rf'^{k}=.*$', lambda m: f'{k}={v}', s, flags=re.M)
open(p, 'w').write(s)
PY
  else
    echo "$1=$v" >> $ENV
  fi
}
cur() { grep "^$1=" $ENV | cut -d= -f2- | tr -d '"'; }
ask() {  # ask NAME "label" hidden(1/0)
  local val
  if [ "$3" = 1 ]; then
    local state; [ -n "$(cur $1)" ] && state="set" || state="empty"
    read -r -s -p "$2 [$state]: " val; echo
  else
    read -r -p "$2 [$(cur $1)]: " val
  fi
  [ -n "$val" ] && setv "$1" "$val" && echo "  saved"
}
echo "Press Enter to keep a value unchanged."
ask RESEND_API_KEY      "Resend API key (re_...)" 1
ask RESEND_FROM         "Alert sender, e.g. Titan <alerts@kitovu.com.ng>" 0
ask TERMII_API_KEY      "Termii API key" 1
ask TERMII_SENDER_ID    "Termii sender ID (as approved by Termii)" 0
ask PAYSTACK_SECRET_KEY "Paystack secret key (sk_live_...)" 1
ask ANTHROPIC_API_KEY   "Anthropic API key (optional, sk-ant-...)" 1
ask MONITOR_EMAILS      "Emails for downtime alerts (comma-separated)" 0
ask MONITOR_PHONES      "Phones for downtime texts, e.g. +23480… (comma-separated)" 0
chmod 600 $ENV; chown titan:titan $ENV
systemctl restart titan; sleep 3
echo "TITAN: $(systemctl is-active titan)"
for k in RESEND_API_KEY TERMII_API_KEY PAYSTACK_SECRET_KEY ANTHROPIC_API_KEY; do
  [ -n "$(cur $k)" ] && echo "$k: set" || echo "$k: empty"
done
echo "Paystack webhook URL: https://titan.kitovu.com.ng/api/paystack/webhook"
