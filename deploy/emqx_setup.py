#!/usr/bin/env python3
"""Configure a fresh EMQX 5.8 for Titan through its REST API (idempotent).
- changes the dashboard admin password (saved to /root/emqx-admin-password.txt)
- HTTP authentication + authorization against Titan, no_match = deny
- rules forwarding device uplinks and disconnects to Titan
- an API key for Titan, written into /opt/titan/.env"""
import json, os, re, secrets, sys, urllib.request, urllib.error

API = 'http://127.0.0.1:18083/api/v5'
ENV = '/opt/titan/.env'
PWFILE = '/root/emqx-admin-password.txt'
TITAN = 'http://127.0.0.1:4600'

env = open(ENV).read()
secret = re.search(r'^TITAN_INTERNAL_SECRET=(.*)$', env, re.M).group(1).strip().strip('"')
hdrs = {'content-type': 'application/json', 'x-titan-internal': secret}
token = None

def call(method, path, body=None, ok_codes=(200, 201, 204)):
    req = urllib.request.Request(API + path, method=method, data=None if body is None else json.dumps(body).encode())
    req.add_header('content-type', 'application/json')
    if token:
        req.add_header('authorization', 'Bearer ' + token)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw.decode(errors='replace')

def step(name, status, body, ok=(200, 201, 204)):
    good = status in ok or (status in (400, 409) and 'ALREADY' in json.dumps(body).upper())
    print(f"{'OK ' if good else 'ERR'} {name}" + ('' if good else f' -> {status} {json.dumps(body)[:200]}'))
    return good

# 1. Log in (saved password first, then the factory default) and change the default password.
saved = open(PWFILE).read().strip() if os.path.exists(PWFILE) else None
for pw in [p for p in (saved, 'public') if p]:
    s, b = call('POST', '/login', {'username': 'admin', 'password': pw})
    if s == 200:
        token = b['token']
        break
if not token:
    print('ERR login: could not sign in to EMQX as admin'); sys.exit(1)
if pw == 'public':
    new = secrets.token_hex(12)
    s, b = call('POST', '/users/admin/change_pwd', {'old_pwd': 'public', 'new_pwd': new})
    if step('dashboard password changed', s, b):
        open(PWFILE, 'w').write(new + '\n'); os.chmod(PWFILE, 0o600)
        token = None  # changing the password revokes the session; sign in again
        s, b = call('POST', '/login', {'username': 'admin', 'password': new})
        if s != 200:
            print('ERR login after password change'); sys.exit(1)
        token = b['token']
else:
    print('OK  dashboard password already set')

# 2. Authentication via Titan.
s, b = call('GET', '/authentication')
for a in b if isinstance(b, list) else []:
    if a.get('backend') == 'http':
        call('DELETE', '/authentication/' + a['id'])
s, b = call('POST', '/authentication', {
    'mechanism': 'password_based', 'backend': 'http', 'enable': True, 'method': 'post',
    'url': TITAN + '/internal/emqx/auth', 'headers': hdrs, 'request_timeout': '5s',
    'body': {'username': '${username}', 'password': '${password}', 'clientid': '${clientid}'}})
step('authentication -> Titan', s, b)

# 3. Authorization via Titan only; anything unmatched is denied.
call('DELETE', '/authorization/sources/file')
call('DELETE', '/authorization/sources/http')
s, b = call('POST', '/authorization/sources', {
    'type': 'http', 'enable': True, 'method': 'post', 'url': TITAN + '/internal/emqx/acl',
    'headers': hdrs, 'request_timeout': '5s',
    'body': {'username': '${username}', 'topic': '${topic}', 'action': '${action}'}})
step('authorization -> Titan', s, b)
s, b = call('PUT', '/authorization/settings', {'no_match': 'deny', 'deny_action': 'ignore',
                                               'cache': {'enable': True, 'max_size': 32, 'ttl': '1m'}})
step('unmatched topics denied', s, b)

# 4. Connector, actions and rules that forward to Titan.
for rid in ('titan_up', 'titan_disconnect'):
    call('DELETE', '/rules/' + rid)
for act in ('titan_message', 'titan_event'):
    call('DELETE', '/actions/http:' + act)
call('DELETE', '/connectors/http:titan')
s, b = call('POST', '/connectors', {'type': 'http', 'name': 'titan', 'enable': True, 'url': TITAN,
                                    'headers': hdrs, 'connect_timeout': '5s', 'pool_size': 8})
step('connector -> Titan', s, b)
for act, path in (('titan_message', '/internal/emqx/message'), ('titan_event', '/internal/emqx/event')):
    s, b = call('POST', '/actions', {'type': 'http', 'name': act, 'connector': 'titan', 'enable': True,
                                     'parameters': {'method': 'post', 'path': path, 'headers': {'content-type': 'application/json'}}})
    step('action ' + act, s, b)
s, b = call('POST', '/rules', {'id': 'titan_up', 'enable': True, 'actions': ['http:titan_message'],
                               'sql': 'SELECT topic, payload, username FROM "titan/v1/+/up/#"'})
step('rule: device uplinks -> Titan', s, b)
s, b = call('POST', '/rules', {'id': 'titan_disconnect', 'enable': True, 'actions': ['http:titan_event'],
                               'sql': 'SELECT event, username FROM "$events/client_disconnected"'})
step('rule: disconnects -> Titan', s, b)

# 5. API key for Titan (to publish configs and commands).
s, b = call('GET', '/api_key')
for k in b if isinstance(b, list) else []:
    if k.get('name') == 'titan':
        call('DELETE', '/api_key/titan')
s, b = call('POST', '/api_key', {'name': 'titan', 'enable': True, 'desc': 'Titan platform'})
if step('API key for Titan', s, b):
    for k, v in (('EMQX_API_KEY', b['api_key']), ('EMQX_API_SECRET', b['api_secret'])):
        env = re.sub(rf'^{k}=.*$', f'{k}={v}', env, flags=re.M) if re.search(rf'^{k}=', env, re.M) else env + f'\n{k}={v}\n'
    open(ENV, 'w').write(env)
    print('OK  API key saved to Titan settings')
