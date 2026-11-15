#!/bin/bash
# End-to-end check on a live server: creates a test device under Kitovu, provisions it over HTTPS,
# sends 3 signed readings and confirms they were stored. Safe to re-run. Run as root from /opt/titan.
set -eu
cd /opt/titan
URL=${1:-https://titan.kitovu.com.ng}
DEV=WG-TEST01
DB=$(grep '^DATABASE_URL=' .env | cut -d= -f2-)
sqlv() { psql "$DB" -tAc "$1"; }
cli() { sudo -u titan npm run -s cli -- "$@"; }
pick() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);console.log(o[process.argv[1]])})' "$1"; }

ORG=$(sqlv "SELECT id FROM organisations WHERE kind='kitovu' LIMIT 1")
SITE=$(sqlv "SELECT id FROM sites WHERE org_id='$ORG' AND name='Titan test site' LIMIT 1")
[ -z "$SITE" ] && SITE=$(cli site:create "$ORG" "Titan test site" | pick id)
if [ -n "$(sqlv "SELECT 1 FROM devices WHERE id='$DEV'")" ]; then
  CODE=$(cli device:code $DEV | pick provisioningCode)
else
  CODE=$(cli device:create $DEV "$ORG" "$SITE" | pick provisioningCode)
fi
echo "Test device $DEV ready"
rm -f .titan-device-$DEV.json
sudo -u titan npx -y tsx tools/simulate-device.ts provision --url "$URL" --device $DEV --code "$CODE"
sudo -u titan npx -y tsx tools/simulate-device.ts run --url "$URL" --device $DEV --count 3 --interval 2
echo "READINGS STORED: $(sqlv "SELECT count(*) FROM readings WHERE device_id='$DEV'")"
echo "DEVICE STATUS: $(sqlv "SELECT status FROM devices WHERE id='$DEV'")"
