# Titan by Kitovu

Connect, verify and share data from any IoT device. Devices send signed readings over MQTT or HTTPS; Titan verifies every message, stores it, raises alerts and makes the data available on a dashboard and through APIs, with access controlled by the data owner.

WareGuard (Kitovu's warehouse monitor) is the first device; StorageX is the first API consumer. Live at `titan.kitovu.com.ng`.

## Docs

- [Device Protocol v1](docs/device-protocol-v1.md): for hardware engineers
- [Product requirements](docs/PRD.md)
- [Deployment](docs/deployment.md)
- [Sensor node reference designs](docs/sensor-nodes.md)
- Integration Guide and API docs: `web/docs/index.html`, served at `/docs/`

## What's built (v1, stage 1)

| Area | Status |
|---|---|
| Database schema + seed (metric registry, crop profiles, WareGuard type) | Done (`db/migrations`) |
| Ingestion: Ed25519 verification, dedupe, validation, buffered/estimated-time labels | Done |
| Derived metrics: dew point, VPD, equilibrium moisture content | Done |
| Alerts: threshold rules (duration, hysteresis), device events, offline, tamper | Done |
| Notifications: email (Resend), SMS (Termii), signed webhooks with retries | Done |
| EMQX hooks: auth, ACL, message and disconnect | Done |
| Provisioning with one-time codes; config push with acknowledgement | Done |
| REST API v1: sites, devices, latest, readings (raw/1m/1h/1d), proofs, alerts, webhooks, grants | Done |
| Data grants (share sites/metrics/time windows with other organisations) | Done |
| Usage metering, invoice generation, Paystack payments | Done |
| Landing page (`web/index.html`) with demo form | Done |
| Admin CLI for bootstrapping (`npm run cli`) | Done |
| StorageX condition reports (`/v1/sites/:id/conditions`) and lookup by StorageX ID | Done |
| API docs with StorageX guide (`/docs/`) | Done |
| Admin/Ops dashboard (`/admin`): fleet, sites, devices, charts, config, commands, alerts, rules, contacts, keys, reporting frequency, plans, usage, team | Done |
| Device commands: catalogue per device type, policies, command log with device confirmation (`/v1/devices/:id/commands`) | Done |
| Automations: readings trigger commands on other devices, with clear commands and cooldown | Done |
| Carbon module: projects, biochar batches (opened/closed by kiln nodes), cookstove periods, lab results with certificate fingerprints, `biochar-v1` and `cookstove-v1` calculations with full lineage | Done |
| Data retention per organisation (30 days to 20 years) | Done |
| Sensor node reference designs (`docs/sensor-nodes.md`) | Done |
| Client console (`/console`): sites, devices with charts and controls, alerts, rules, sharing, API keys and webhooks, carbon (read), billing with Paystack, team | Done |
| MCP server for AI agents (`/mcp`), same permissions as the API key | Done |
| LoRa gateway relay (Protocol v1.1) | Next |

## Develop

```bash
npm install
cp .env.example .env
npm run migrate
npm run dev
npm test
```

Tests use an in-memory store. To also check the Postgres SQL against a real database:
`TITAN_TEST_PSQL="-h localhost -U titan titan_test" npm test` (database must have the migrations applied).

## Layout

```
db/migrations/      SQL schema and seed
src/core/           envelope parsing + signature checks, derived metrics, rules, access, device config
src/ingest/         ingestion pipeline, device service (auth, ACL, provisioning, downlinks)
src/notify/         Resend/Termii adapters, alert + webhook dispatcher
src/store/          Store interface, Postgres and in-memory implementations
src/http/           tiny router and all HTTP routes
src/billing/        invoices and Paystack
src/workers/        offline sweeper, webhook delivery, monthly invoicing
web/                landing page (served at /)
deploy/             systemd unit, Nginx config
```
