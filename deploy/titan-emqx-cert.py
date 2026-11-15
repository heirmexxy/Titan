#!/usr/bin/env python3
"""Copy the mqtt.titan.kitovu.com.ng certificate that Dokploy's Traefik obtained into EMQX.
Run after setup and daily (cron). Restarts EMQX only when the certificate changed.
Usage: titan-emqx-cert.py [--wait SECONDS] [--no-restart]"""
import base64, glob, json, os, subprocess, sys, time

DOMAIN = os.environ.get('MQTT_DOMAIN', 'mqtt.titan.kitovu.com.ng')
OUT = '/etc/emqx/certs'
wait = int(sys.argv[sys.argv.index('--wait') + 1]) if '--wait' in sys.argv else 0

def find():
    for path in glob.glob('/etc/dokploy/traefik/**/acme.json', recursive=True):
        try:
            data = json.load(open(path))
        except Exception:
            continue
        for resolver in data.values():
            for c in (resolver or {}).get('Certificates') or []:
                d = c.get('domain', {})
                if DOMAIN == d.get('main') or DOMAIN in (d.get('sans') or []):
                    return base64.b64decode(c['certificate']), base64.b64decode(c['key'])
    return None

deadline = time.time() + wait
found = find()
while not found and time.time() < deadline:
    time.sleep(5)
    found = find()
if not found:
    print(f'CERT: not issued yet for {DOMAIN}')
    sys.exit(1)

cert, key = found
os.makedirs(OUT, exist_ok=True)
cpath, kpath = f'{OUT}/titan-fullchain.pem', f'{OUT}/titan-privkey.pem'
changed = not os.path.exists(cpath) or open(cpath, 'rb').read() != cert
if changed:
    open(cpath, 'wb').write(cert)
    open(kpath, 'wb').write(key)
    os.chmod(kpath, 0o600)
    subprocess.run(['chown', 'emqx:emqx', cpath, kpath], check=False)
    if '--no-restart' not in sys.argv:
        subprocess.run(['systemctl', 'restart', 'emqx'], check=False)
print('CERT: updated' if changed else 'CERT: unchanged')
