#!/usr/bin/env python3
"""Titan watchdog: runs every minute from a systemd timer (titan-watchdog.timer).

- Restarts titan, emqx or postgresql if the service has stopped.
- Restarts titan if /healthz/deep stops answering for 3 minutes.
- Emails (Resend) and texts (Termii) MONITOR_EMAILS / MONITOR_PHONES from /opt/titan/.env when something
  breaks (after 2 bad minutes), every 6 hours while it stays broken, and when it recovers.
- Records its own heartbeat, shown on the admin System health page.
"""
import json, os, subprocess, time, urllib.request

ENV_FILE = '/opt/titan/.env'
STATE = '/var/lib/titan-watchdog/state.json'
SERVICES = ['postgresql', 'titan', 'emqx']

def env():
    out = {}
    for line in open(ENV_FILE):
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line: continue
        k, v = line.split('=', 1)
        out[k.strip()] = v.strip().strip('"')
    return out

E = env()
os.makedirs(os.path.dirname(STATE), exist_ok=True)
try: state = json.load(open(STATE))
except Exception: state = {'bad_runs': 0, 'no_answer_runs': 0, 'alerting': False, 'last_alert': 0}

def sh(*a):
    return subprocess.run(a, capture_output=True, text=True)

problems, actions = [], []
for s in SERVICES:
    if sh('systemctl', 'is-active', '--quiet', s).returncode != 0:
        problems.append(f'{s} service was down')
        sh('systemctl', 'restart', s)
        actions.append(f'restarted {s}')

port = E.get('PORT', '4600')
health = None
try:
    with urllib.request.urlopen(f'http://127.0.0.1:{port}/healthz/deep', timeout=15) as r: health = json.load(r)
except urllib.error.HTTPError as e:
    try: health = json.load(e)
    except Exception: health = None
except Exception:
    health = None

if health is None:
    state['no_answer_runs'] = state.get('no_answer_runs', 0) + 1
    problems.append('Titan is not answering health checks')
    if state['no_answer_runs'] >= 3:
        sh('systemctl', 'restart', 'titan'); actions.append('restarted titan (not answering)'); state['no_answer_runs'] = 0
else:
    state['no_answer_runs'] = 0
    for c in health.get('checks', []):
        if not c.get('ok') and c.get('level') == 'critical': problems.append(f"{c['name']} check failing")

def notify(subject, text):
    to = [x.strip() for x in E.get('MONITOR_EMAILS', 'titan@kitovu.com.ng').split(',') if x.strip()]
    if E.get('RESEND_API_KEY') and to:
        req = urllib.request.Request('https://api.resend.com/emails', method='POST', headers={'Authorization': f"Bearer {E['RESEND_API_KEY']}", 'Content-Type': 'application/json'},
            data=json.dumps({'from': E.get('RESEND_FROM', 'Titan <alerts@titan.kitovu.com.ng>'), 'to': to, 'subject': subject, 'text': text}).encode())
        try: urllib.request.urlopen(req, timeout=15).read()
        except Exception as e: print('email failed', e)
    phones = [x.strip().lstrip('+') for x in E.get('MONITOR_PHONES', '').split(',') if x.strip()]
    if E.get('TERMII_API_KEY'):
        for p in phones:
            req = urllib.request.Request(E.get('TERMII_BASE_URL', 'https://v3.api.termii.com') + '/api/sms/send', method='POST', headers={'Content-Type': 'application/json'},
                data=json.dumps({'to': p, 'from': E.get('TERMII_SENDER_ID', 'Titan'), 'sms': f'{subject}. {text[:120]}', 'type': 'plain', 'channel': 'generic', 'api_key': E['TERMII_API_KEY']}).encode())
            try: urllib.request.urlopen(req, timeout=15).read()
            except Exception as e: print('sms failed', e)

now = time.time()
host = os.uname().nodename
if problems:
    state['bad_runs'] = state.get('bad_runs', 0) + 1
    if state['bad_runs'] >= 2 and (not state.get('alerting') or now - state.get('last_alert', 0) > 6 * 3600):
        notify('Titan needs attention', f"On {host}: " + '; '.join(problems) + (f". Done automatically: {', '.join(actions)}." if actions else '.') + ' Details: https://titan.kitovu.com.ng/admin/#health')
        state['alerting'] = True; state['last_alert'] = now
else:
    if state.get('alerting'):
        notify('Titan has recovered', f'On {host}: all checks are passing again.')
    state.update({'bad_runs': 0, 'alerting': False})

json.dump(state, open(STATE, 'w'))
detail = json.dumps({'problems': problems, 'actions': actions})
db = E.get('DATABASE_URL')
if db and health is not None:
    sh('psql', db, '-q', '-c', f"INSERT INTO system_heartbeats (name, beat_at, detail) VALUES ('watchdog', now(), '{detail.replace(chr(39), chr(39)*2)}'::jsonb) ON CONFLICT (name) DO UPDATE SET beat_at = now(), detail = EXCLUDED.detail")
print('ok' if not problems else '; '.join(problems + actions))
