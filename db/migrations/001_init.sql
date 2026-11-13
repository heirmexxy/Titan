-- Titan v1 schema. Works on plain PostgreSQL 14+; uses TimescaleDB when installed.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb') THEN
    CREATE EXTENSION IF NOT EXISTS timescaledb;
  END IF;
END $$;

-- ---------- Organisations, people, access ----------
CREATE TABLE organisations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  kind          text NOT NULL DEFAULT 'client' CHECK (kind IN ('kitovu','client','consumer')),
  billing_email text,
  device_prefix text UNIQUE,              -- e.g. WG for Kitovu/WareGuard
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organisations(id),
  email         text NOT NULL UNIQUE,
  name          text,
  role          text NOT NULL CHECK (role IN ('admin','ops','client_owner','client_member')),
  password_hash text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organisations(id),
  name        text NOT NULL,
  prefix      text NOT NULL,                 -- first chars, shown in UI
  key_hash    text NOT NULL UNIQUE,          -- sha256 of full key
  scopes      text[] NOT NULL DEFAULT ARRAY['read:readings','read:alerts'],
  last_used_at timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- Places ----------
CREATE TABLE sites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organisations(id),
  name        text NOT NULL,
  kind        text NOT NULL DEFAULT 'warehouse'
              CHECK (kind IN ('warehouse','aquaponics','hydroponics','greenhouse','cold_room','poultry','field','energy','other')),
  external_ref text,                         -- e.g. StorageX warehouse ID
  address     text,
  lat         double precision,
  lng         double precision,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON sites (org_id);

CREATE TABLE zones (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id  uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  code     text NOT NULL,                    -- matches first segment of device channel, e.g. z1
  name     text,
  UNIQUE (site_id, code)
);

CREATE TABLE stacks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id      uuid NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  code         text NOT NULL,                -- matches second segment, e.g. stack-a
  commodity    text,                         -- crop key, e.g. maize
  external_ref text,                         -- e.g. StorageX lot ID
  UNIQUE (zone_id, code)
);

-- ---------- Registry ----------
CREATE TABLE metrics (
  key         text PRIMARY KEY,              -- air.temperature
  unit        text NOT NULL,
  label       text NOT NULL,
  kind        text NOT NULL DEFAULT 'gauge' CHECK (kind IN ('gauge','binary','counter')),
  min_valid   double precision,
  max_valid   double precision,
  derived     boolean NOT NULL DEFAULT false
);

CREATE TABLE crop_profiles (
  crop        text PRIMARY KEY,              -- maize
  label       text NOT NULL,
  henderson_k double precision,              -- modified Henderson EMC parameters (verify before production use)
  henderson_n double precision,
  henderson_c double precision,
  safe_moisture double precision            -- % wet basis
);

CREATE TABLE calibration_profiles (
  id          text PRIMARY KEY,              -- maize-cap-v2
  crop        text REFERENCES crop_profiles(crop),
  sensor      text NOT NULL,
  formula     jsonb NOT NULL,                -- e.g. {"type":"poly","coef":[a,b,c]} raw -> % wb
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE device_types (
  id            text PRIMARY KEY,            -- wareguard-v1
  name          text NOT NULL,
  manufacturer_org_id uuid REFERENCES organisations(id),
  defaults      jsonb NOT NULL DEFAULT '{}'  -- {"wifi":{"telemetry_s":10,...},"gsm":{...}}
);

-- ---------- Devices ----------
CREATE TABLE devices (
  id            text PRIMARY KEY,            -- WG-000123
  org_id        uuid NOT NULL REFERENCES organisations(id),
  site_id       uuid REFERENCES sites(id),
  type_id       text NOT NULL REFERENCES device_types(id),
  name          text,
  connectivity  text NOT NULL DEFAULT 'wifi' CHECK (connectivity IN ('wifi','gsm')),
  token_hash    text,                        -- sha256 of MQTT device token
  provision_code_hash text,
  provision_expires_at timestamptz,
  status        text NOT NULL DEFAULT 'registered' CHECK (status IN ('registered','online','offline','disabled')),
  last_seen_at  timestamptz,
  last_seq      bigint,
  last_state    jsonb,
  heartbeat_s   integer NOT NULL DEFAULT 60,
  config_override jsonb NOT NULL DEFAULT '{}',
  config_version integer NOT NULL DEFAULT 0,
  config_acked_version integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON devices (org_id);
CREATE INDEX ON devices (site_id);

CREATE TABLE device_keys (
  device_id   text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  key_id      text NOT NULL,                 -- k1, k2, h1
  alg         text NOT NULL CHECK (alg IN ('ed25519','hmac-sha256')),
  public_key  text NOT NULL,                 -- base64url raw key (ed25519) or secret (hmac, encrypted at rest)
  created_at  timestamptz NOT NULL DEFAULT now(),
  retired_at  timestamptz,
  PRIMARY KEY (device_id, key_id)
);

-- Raw signed envelopes: kept so any reading can be re-verified.
CREATE TABLE messages (
  device_id   text NOT NULL,
  seq         bigint NOT NULL,
  kind        text NOT NULL,
  key_id      text NOT NULL,
  payload_b64 text NOT NULL,
  sig_b64     text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, seq)
);

-- ---------- Time series ----------
-- flags bitmask: 1 = buffered, 2 = time_estimated, 4 = derived, 8 = shared-secret integrity
CREATE TABLE readings (
  time        timestamptz NOT NULL,
  org_id      uuid NOT NULL,
  site_id     uuid,
  device_id   text NOT NULL,
  channel     text NOT NULL,
  metric      text NOT NULL,
  value       double precision NOT NULL,
  quality     text NOT NULL DEFAULT 'ok' CHECK (quality IN ('ok','suspect','fault','rejected')),
  flags       smallint NOT NULL DEFAULT 0,
  seq         bigint,
  cal         text
);
CREATE INDEX ON readings (site_id, metric, time DESC);
CREATE INDEX ON readings (device_id, time DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM create_hypertable('readings', 'time', chunk_time_interval => INTERVAL '1 day');
    PERFORM add_retention_policy('readings', INTERVAL '2 years');
  END IF;
END $$;

CREATE TABLE events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  time        timestamptz NOT NULL,
  org_id      uuid NOT NULL,
  site_id     uuid,
  device_id   text NOT NULL,
  code        text NOT NULL,
  severity    text NOT NULL DEFAULT 'info',
  channel     text,
  message     text,
  seq         bigint
);
CREATE INDEX ON events (site_id, time DESC);

-- ---------- Config ----------
CREATE TABLE device_configs (
  device_id   text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  version     integer NOT NULL,
  doc         jsonb NOT NULL,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  acked_at    timestamptz,
  PRIMARY KEY (device_id, version)
);

-- ---------- Alerts ----------
CREATE TABLE alert_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organisations(id),
  site_id     uuid REFERENCES sites(id),     -- null = all sites of org
  device_id   text REFERENCES devices(id),   -- null = all devices in scope
  channel     text,                          -- null = any channel
  metric      text NOT NULL REFERENCES metrics(key),
  op          text NOT NULL CHECK (op IN ('gt','lt')),
  threshold   double precision NOT NULL,
  duration_s  integer NOT NULL DEFAULT 0,
  hysteresis  double precision NOT NULL DEFAULT 0,
  severity    text NOT NULL DEFAULT 'warning' CHECK (severity IN ('info','warning','critical')),
  enabled     boolean NOT NULL DEFAULT true,
  name        text
);

CREATE TABLE rule_state (
  rule_id     uuid NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  device_id   text NOT NULL,
  channel     text NOT NULL,
  breach_since timestamptz,
  alert_id    uuid,
  PRIMARY KEY (rule_id, device_id, channel)
);

CREATE TABLE alerts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  site_id     uuid,
  device_id   text,
  channel     text,
  rule_id     uuid,
  code        text NOT NULL,                 -- threshold, device_offline, tamper, intruder_detected...
  severity    text NOT NULL,
  title       text NOT NULL,
  value       double precision,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  opened_at   timestamptz NOT NULL DEFAULT now(),
  acked_at    timestamptz,
  acked_by    uuid,
  resolved_at timestamptz
);
CREATE INDEX ON alerts (org_id, status, opened_at DESC);
CREATE INDEX ON alerts (site_id, opened_at DESC);

CREATE TABLE notification_contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organisations(id),
  site_id     uuid REFERENCES sites(id),
  channel     text NOT NULL CHECK (channel IN ('email','sms')),
  address     text NOT NULL,
  min_severity text NOT NULL DEFAULT 'warning'
);

-- ---------- Sharing ----------
CREATE TABLE data_grants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_org_id  uuid NOT NULL REFERENCES organisations(id),
  grantee_org_id uuid NOT NULL REFERENCES organisations(id),
  site_ids      uuid[],                      -- null = all owner sites
  metrics       text[],                      -- null = all metrics
  valid_from    timestamptz,                 -- data window start (null = unbounded)
  valid_to      timestamptz,                 -- data window end
  live          boolean NOT NULL DEFAULT true,   -- include webhooks
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON data_grants (grantee_org_id) WHERE revoked_at IS NULL;

CREATE TABLE webhooks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organisations(id),
  url         text NOT NULL,
  events      text[] NOT NULL,               -- alert.opened, alert.resolved, device.offline, reading.created
  secret      text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id  uuid NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event       text NOT NULL,
  body        jsonb NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed')),
  last_status_code integer,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON webhook_deliveries (status, next_attempt_at);

-- ---------- Billing ----------
CREATE TABLE usage_daily (
  org_id      uuid NOT NULL,
  day         date NOT NULL,
  messages    bigint NOT NULL DEFAULT 0,
  readings    bigint NOT NULL DEFAULT 0,
  api_calls   bigint NOT NULL DEFAULT 0,
  webhooks    bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, day)
);

CREATE TABLE usage_devices_daily (
  org_id      uuid NOT NULL,
  day         date NOT NULL,
  device_id   text NOT NULL,
  PRIMARY KEY (org_id, day, device_id)
);

CREATE TABLE plans (
  id              text PRIMARY KEY,
  name            text NOT NULL,
  currency        text NOT NULL DEFAULT 'NGN',
  price_per_device numeric(14,2) NOT NULL DEFAULT 0,  -- per device per month
  base_fee        numeric(14,2) NOT NULL DEFAULT 0,
  included_api_calls bigint NOT NULL DEFAULT 0,
  overage_per_1k_calls numeric(14,2) NOT NULL DEFAULT 0,
  features        text[] NOT NULL DEFAULT '{}',
  published       boolean NOT NULL DEFAULT false,
  sort            integer NOT NULL DEFAULT 0
);

CREATE TABLE subscriptions (
  org_id      uuid PRIMARY KEY REFERENCES organisations(id),
  plan_id     text NOT NULL REFERENCES plans(id),
  started_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invoices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organisations(id),
  period      text NOT NULL,                 -- 2026-11
  currency    text NOT NULL,
  lines       jsonb NOT NULL,
  amount      numeric(14,2) NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','void')),
  paystack_reference text UNIQUE,
  paid_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, period)
);

-- ---------- Misc ----------
CREATE TABLE demo_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  email       text NOT NULL,
  company     text,
  phone       text,
  use_case    text,
  message     text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  time        timestamptz NOT NULL DEFAULT now(),
  actor       text NOT NULL,                 -- user:<id> | apikey:<id> | system
  org_id      uuid,
  action      text NOT NULL,
  target      text,
  detail      jsonb
);

COMMIT;
