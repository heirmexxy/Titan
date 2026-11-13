# Deploying Titan

Target: the Hostinger KVM 2 that does **not** run Abia ADDS. Native installs, no Docker. Do the steps in order; each one should work before you move on.

## Step 1. DNS

In Hostinger hPanel, add two A records pointing to the server's IP:

- `titan.kitovu.com.ng`
- `mqtt.titan.kitovu.com.ng`

## Step 2. PostgreSQL 16 + TimescaleDB

```bash
sudo apt install -y postgresql-16
# TimescaleDB: follow https://docs.timescale.com/self-hosted/latest/install/installation-linux/ for Ubuntu
sudo -u postgres psql -c "CREATE ROLE titan LOGIN PASSWORD 'CHANGE_ME';"
sudo -u postgres psql -c "CREATE DATABASE titan OWNER titan;"
sudo -u postgres psql -d titan -c "CREATE EXTENSION IF NOT EXISTS timescaledb;"
```

Titan also runs on plain PostgreSQL (no Timescale), just with slower long-range queries.

## Step 3. Titan app

```bash
sudo useradd -r -m -d /opt/titan titan
sudo -u titan git clone https://github.com/heirmexxy/Titan /opt/titan
cd /opt/titan
sudo -u titan cp .env.example .env    # then fill in the values
sudo -u titan npm ci
sudo -u titan npm run build
sudo -u titan npm run migrate
sudo cp deploy/titan.service /etc/systemd/system/
sudo systemctl enable --now titan
curl http://127.0.0.1:4600/healthz
```

## Step 4. Nginx + TLS

```bash
sudo cp deploy/nginx-titan.conf /etc/nginx/sites-available/titan
sudo ln -s /etc/nginx/sites-available/titan /etc/nginx/sites-enabled/
sudo certbot --nginx -d titan.kitovu.com.ng -d mqtt.titan.kitovu.com.ng
```

## Step 5. EMQX (MQTT broker)

Install EMQX 5 (open-source) from the official `.deb` for your Ubuntu version and start it. Then in the EMQX dashboard (`http://SERVER:18083`, reachable only through an SSH tunnel; block 18083 in the firewall):

1. **Listeners**: enable SSL on 8883 using the Let's Encrypt cert for `mqtt.titan.kitovu.com.ng` (`/etc/letsencrypt/live/.../fullchain.pem` and `privkey.pem`). Disable the plain 1883 listener on the public interface.
2. **Authentication → HTTP server**: `POST http://127.0.0.1:4600/internal/emqx/auth`, header `X-Titan-Internal: <TITAN_INTERNAL_SECRET>`, body `{"username":"${username}","password":"${password}","clientid":"${clientid}"}`.
3. **Authorization → HTTP server**: `POST http://127.0.0.1:4600/internal/emqx/acl`, same header, body `{"username":"${username}","topic":"${topic}","action":"${action}"}`. Set *no match* to **deny**.
4. **Rules → new rule** with SQL `SELECT topic, payload, username FROM "titan/v1/+/up/#"`, action **HTTP server** `POST http://127.0.0.1:4600/internal/emqx/message`, same header, body left empty (sends the rule output as JSON).
5. **Rules → new rule** with SQL `SELECT event, username FROM "$events/client_disconnected"`, action `POST http://127.0.0.1:4600/internal/emqx/event`, same header.
6. **API keys**: create one and put it in `.env` as `EMQX_API_KEY` / `EMQX_API_SECRET` (Titan uses it to publish configs and commands). Restart Titan.

Renew hook: after certbot renews, reload EMQX so it picks up the new cert.

## Step 6. First admin account

```bash
npm run cli -- user:create e.nwachinemere@kitovu.com.ng admin --name "Emeka"
```

Sign in at `https://titan.kitovu.com.ng/admin` with the temporary password and change it under Settings. Everything below can also be done in the dashboard.

## Step 7. First devices from the command line (optional)

```bash
cd /opt/titan
npm run cli -- org:list                                  # Kitovu org id
npm run cli -- site:create <orgId> "Iseyin Warehouse" --ref <StorageX warehouse id>
npm run cli -- zone:create <siteId> z1
npm run cli -- stack:create <siteId> z1 stack-a --crop maize
npm run cli -- device:create WG-000001 <orgId> <siteId>  # prints the provisioning code
npm run cli -- contact:add <orgId> email ops@kitovu.com.ng
npm run cli -- rule:create <orgId> air.humidity gt 75 --duration 600 --hysteresis 3
npm run cli -- apikey:create <orgId> "StorageX" --scopes read:readings,read:alerts,manage:webhooks,manage:grants
```

## Step 8. Backups

Nightly `pg_dump -Fc titan` to a file, then upload to Google Drive (e.g. with `rclone`). Keep 30 days.

## Paystack

Webhook URL: `https://titan.kitovu.com.ng/api/paystack/webhook`. Callback URL: `https://titan.kitovu.com.ng/api/paystack/callback`. Until Paystack allows several webhooks per account, payments are confirmed on the callback using the verify API.
