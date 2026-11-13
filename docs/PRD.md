# Titan — Product Requirements (v1)

**Product:** Titan by Kitovu · **URL:** `titan.kitovu.com.ng` · **Repo:** `heirmexxy/Titan` · **Stack:** Node.js + TypeScript, PostgreSQL + TimescaleDB, EMQX · **Status:** v1 build

## 1. What Titan is

Titan is one place to **connect, verify and share** data from any IoT device. Devices send readings to Titan; Titan checks that every reading is genuine, stores it, raises alerts, and makes it available on a dashboard and through APIs to the systems and partners that need it.

Kitovu's own WareGuard warehouse monitors are the first devices. Titan is built from day one for any device: aquaponics and hydroponics controllers, greenhouse and irrigation sensors, cold rooms, poultry houses, solar and power meters.

### Offerings

| Offering | For | What they get |
|---|---|---|
| **Titan Cloud** | Businesses and hardware makers with their own devices | Device connectivity (MQTT/HTTPS), storage, alerts, dashboard, APIs |
| **Titan + WareGuard** | Warehouse operators, aggregators, commodity financiers | Kitovu's warehouse monitoring hardware, installed and managed, data on Titan |
| **Titan Data API** | Lenders, insurers, buyers, platforms (e.g. StorageX) | Verified site-condition data, shared with permission from the data owner |

## 2. Problem, for whom

- **Operators** (warehouses, farms, cold chain): find out about spoilage, theft and equipment failure after the loss. Each device vendor has its own dashboard; nothing joins up.
- **Hardware makers**: spend months building cloud backends, dashboards and APIs instead of devices.
- **Financiers and insurers**: lend against stored goods or insure farms with no trustworthy view of conditions on site. Self-reported data can't be relied on.

Titan's answer: a shared, device-neutral backend where every reading is **signed by the device that took it**, and access is granted by the data owner.

## 3. Users and roles

| Role | Where | Can |
|---|---|---|
| **Admin** (Kitovu) | Titan admin dashboard | Everything: organisations, device types, metric registry, calibration profiles, plans and prices, reporting-frequency defaults, provisioning |
| **Ops** (Kitovu) | Titan admin dashboard | Monitor all sites and devices, handle alerts, push configs, provision devices. No pricing/billing edits |
| **Client owner / member** (external organisation) | Client console | Their own sites and devices, API keys, data grants, alert rules, usage and billing |
| **API consumer** (StorageX, lenders, client systems) | REST API + webhooks | Only what their key's scopes and data grants allow |

Warehouse managers and lenders do **not** log into Titan; they see Titan data inside StorageX or their own platforms through the API.

## 4. Data ownership and sharing

- Kitovu owns data from all WareGuard installations.
- Data from third-party devices is owned by the organisation that owns the device.
- The owner shares through **data grants**: grantee organisation, sites (or all), metrics (or all), time window (from/to), and whether live webhooks are included. Grants can be revoked at any time. Every API read is logged against the grant.

## 5. Functional requirements

### 5.1 Ingestion
- EMQX broker on `mqtt.titan.kitovu.com.ng:8883` (and WSS 443). EMQX authenticates and authorises each connection by calling Titan (`/internal/emqx/auth`, `/internal/emqx/acl`) and forwards every uplink message to Titan (`/internal/emqx/message`), plus connect/disconnect events.
- HTTPS fallback `POST /api/ingest`.
- Envelope, signing and topics per **Titan Device Protocol v1** (`docs/device-protocol-v1.md`).
- Pipeline: verify signature → dedupe by (device, seq) → validate against the metric registry → label `live`/`buffered`/`time_estimated` → compute derived metrics → store → evaluate rules → meter usage.
- Raw signed payload kept for every message, so any reading can be re-verified (`GET /v1/readings/proof`).

### 5.2 Data model (core)
`organisations` → `sites` → `zones` → `stacks`; `device_types`; `devices` (org, site, type, connectivity, public keys); `channels` (device channel → zone/stack); `metrics` (registry); `calibration_profiles`; `readings` (hypertable); `messages` (raw signed envelopes); `events`; `alert_rules`; `alerts`; `device_configs`; `api_keys`; `data_grants`; `webhooks`; `usage_daily`; `plans`; `subscriptions`; `invoices`; `audit_log`.

### 5.3 Derived metrics
- Dew point (Magnus formula) from air temperature + humidity.
- Equilibrium moisture content (modified Henderson, crop parameters stored per crop profile; admin-editable) — tells you which moisture the grain is being pushed towards.
- VPD for greenhouse/hydroponic sites.

### 5.4 Alerts
- Rules: metric, scope (org / site / device / channel), operator, threshold, minimum duration, hysteresis, severity.
- System rules: device offline (no message in 3× heartbeat or broker disconnect), signature failure (tamper), sensor fault, device-sent events.
- Lifecycle: open → acknowledged → resolved, with who/when.
- Channels: **email (Resend)**, **SMS (Termii)**, **webhooks/API** (HMAC-signed). Providers are adapters; keys added later.

### 5.5 Reporting frequency
Admin sets defaults per device type × connectivity (Wi-Fi/GSM), with per-device overrides. Changes publish a new retained config to the device and show *pending* until acknowledged.

### 5.6 API (v1)
Bearer API keys (`tk_live_…`), hashed at rest, scoped (`read:readings`, `read:alerts`, `manage:webhooks`, `manage:grants`). Device config (thresholds, intervals) is changed in the admin dashboard in v1.

| Endpoint | Purpose |
|---|---|
| `GET /v1/sites`, `GET /v1/sites/:id` | Sites visible to the caller (own + granted) |
| `GET /v1/devices`, `GET /v1/devices/:id` | Devices and status |
| `GET /v1/latest?site=` | Latest value per metric/channel |
| `GET /v1/readings?site=&device=&metric=&channel=&from=&to=&interval=raw\|1m\|1h\|1d` | History, raw or aggregated (avg/min/max) |
| `GET /v1/readings/proof?device=&seq=` | Original signed payload + public key, for independent verification |
| `GET /v1/alerts?site=&status=` | Alerts |
| `POST /v1/webhooks`, `GET`, `DELETE` | Subscribe to `alert.*`, `reading.*`, `device.*` |
| `POST /v1/grants`, `GET`, `DELETE` | Owner manages data grants |

Webhooks are signed: header `X-Titan-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + body)>`.

### 5.7 StorageX integration
- StorageX holds a Titan API key for Kitovu's organisation (WareGuard data) and receives grants from any third-party warehouse.
- Mapping: StorageX warehouse ID ↔ Titan site ID; StorageX stack/lot ↔ Titan stack.
- StorageX subscribes to `alert.opened` for its sites and flags affected lots/receipts.
- StorageX pulls condition history for a receipt's storage period and attaches it to the receipt (min/max/avg temperature, humidity, moisture; alerts; data completeness; integrity status).

### 5.8 Billing
- Usage metered per organisation per day: active devices, messages, readings, API calls, webhook deliveries.
- Plans set by Admin (price per device per month, included API calls, overage price, NGN/USD). Landing page shows active plans, or "Talk to us" if none are published.
- Monthly invoice generated from usage; payment via Paystack. Payments confirmed via Paystack webhook (Kitovu is getting multiple webhooks per account) with the verify API as fallback.

### 5.9 Interfaces
- **Landing page** (`/`): SB7 story; demo requests go to `titan@kitovu.com.ng` via Resend.
- **Admin/Ops dashboard** (`/admin`): fleet map, live site views, alert inbox, device provisioning, config, registry, plans.
- **Client console** (`/console`): sites, devices, charts, API keys, grants, webhooks, alert rules, usage and invoices.
- **API docs** (`/docs`).

### 5.10 Device control
- Each device type declares its commands (name, arguments with types and ranges, and who may send them: admin, ops, API, automation). Built-in: `alarm_ack`, `send_state`, `time_sync`, `reboot`.
- Every command is validated, logged with its sender, published to the device and marked `acked` or `failed` from the device's reply.
- Automations: a reading condition (metric, limit, duration, clear margin) on any device sends a command to a target device of the same organisation, with an optional command when it clears and a cooldown. Actuators fall back to a safe default after `failsafe_s` without contact.
- API: `GET/POST /v1/devices/:id/commands` (scope `control:devices`, owner only).

### 5.11 Carbon
- Projects (owner org, sites, method, registry, parameters) with activities: biochar **batches** (opened and closed by kiln-node button events, or manually) and cookstove **periods**.
- Measurements and lab results are append-only; corrections supersede. Certificates are recorded by file name and SHA-256 fingerprint.
- Methods: `biochar-v1` (dry biochar × organic carbon × permanence factor from held kiln temperature × 44/12, less project emissions and buffer; H/Corg ≤ 0.7) and `cookstove-v1` (sessions from stove temperature × baseline fuel parameters × fNRB × emission factor). Results store inputs and the signed-message range behind each.
- Verifiers and buyers read projects through data grants (scope `read:carbon`); owners write with `write:carbon`.
- Parameters must be aligned with the registry methodology before credits are issued.

### 5.12 Retention
Retention is set per organisation (default 2 years, up to 20) so carbon projects can keep data for their full crediting period. A nightly job removes readings and raw messages past each organisation's period.

### 5.13 AI agents (MCP)
`POST /mcp` implements the Model Context Protocol (Streamable HTTP, JSON responses). Authenticated with a Titan API key; every tool forwards to the REST API with that key, so agents inherit its scopes, grants, rate limits and audit trail. Device control tools appear only for keys with `control:devices` and are marked as actions that change the physical world.

### 5.14 Client console
`/console` for client owners and members: sites, zones and stacks; device registration under the organisation's prefix with provisioning codes; device charts and controls (commands allowed for API use); alerts; alert rules and contacts; sharing (grants by Organisation ID); API keys and webhooks; carbon (read); invoices with Paystack payment; team. Members can view and acknowledge alerts only. Kitovu creates the first owner login from the admin dashboard.

## 6. Non-functional

- Hosting: second Hostinger KVM 2 (the one not running Abia ADDS), native installs (no Docker): PostgreSQL 16 + TimescaleDB, EMQX, Node 22 under systemd, Nginx + Let's Encrypt.
- Retention: per organisation (default 2 years); see 5.12.
- Backups: nightly `pg_dump` off-site to Google Drive.
- Security: TLS everywhere, device Ed25519 signatures, hashed API keys and device tokens, per-device ACLs in the broker, audit log of admin actions, rate limits per key.
- Capacity target for v1: 500 devices at 10 s intervals (~4.3M readings/day) on one KVM 2; database moves to its own server when outside clients grow.

## 7. Build order

1. Device Protocol v1 ✅
2. PRD ✅
3. Landing page
4. Backend: schema, ingestion, signing, rules, alerts, API, grants, webhooks, metering, billing
5. Admin/Ops dashboard
6. Client console + API docs
7. Deployment to the VPS, then WareGuard pilot devices

## 8. Open items (not blocking)

- Plan prices (set in admin when ready).
- Termii and Resend API keys.
- Paystack multi-webhook support (fallback in place).
- Crop calibration curves for moisture (calibration owner to supply; profiles editable).
