-- Titan v1.2: firmware updates over the air, self-serve sign-up, PAYG, verifiers and registries,
-- GradeGuard quality and traceability, and uptime monitoring.
BEGIN;

-- ---------- Roles and organisation kinds ----------
ALTER TABLE organisations DROP CONSTRAINT IF EXISTS organisations_kind_check;
ALTER TABLE organisations ADD CONSTRAINT organisations_kind_check CHECK (kind IN ('kitovu','client','consumer','verifier'));
ALTER TABLE organisations ADD COLUMN phone text;
ALTER TABLE organisations ADD COLUMN use_case text;
ALTER TABLE organisations ADD COLUMN signup_source text NOT NULL DEFAULT 'admin' CHECK (signup_source IN ('admin','self'));
ALTER TABLE organisations ADD COLUMN paystack_subaccount text;   -- PAYG collections settle to the client

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','ops','client_owner','client_member','verifier'));
-- People added by Kitovu or by an account owner are trusted; self-serve sign-ups start unverified (NULL).
ALTER TABLE users ADD COLUMN email_verified_at timestamptz DEFAULT now();

-- One-time links: email verification and password reset. Only the hash is stored.
CREATE TABLE user_tokens (
  id          text PRIMARY KEY,               -- sha256 of the token
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('verify_email','reset_password')),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- Self-serve plans, trials and saved cards ----------
ALTER TABLE plans ADD COLUMN trial_days integer NOT NULL DEFAULT 14 CHECK (trial_days BETWEEN 0 AND 365);
ALTER TABLE plans ADD COLUMN device_limit integer;            -- null = unlimited
ALTER TABLE plans ADD COLUMN self_serve boolean NOT NULL DEFAULT false;
ALTER TABLE plans ADD COLUMN description text;

ALTER TABLE subscriptions ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('trialing','active','past_due','cancelled'));
ALTER TABLE subscriptions ADD COLUMN trial_ends_at timestamptz;

CREATE TABLE payment_methods (
  org_id          uuid PRIMARY KEY REFERENCES organisations(id),
  authorization_code text NOT NULL,           -- Paystack reusable authorization
  email           text NOT NULL,
  card_brand      text,
  last4           text,
  exp             text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE invoices ADD COLUMN charge_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN last_charge_error text;

-- ---------- Firmware updates over the air ----------
CREATE TABLE firmware_releases (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid REFERENCES organisations(id),  -- null = published by Kitovu for every owner of this device type
  type_id     text NOT NULL REFERENCES device_types(id),
  version     text NOT NULL,
  file_path   text NOT NULL,
  size        bigint NOT NULL,
  sha256      text NOT NULL,                  -- hex of the binary
  signature   text NOT NULL,                  -- base64url Ed25519 over the 32 sha256 bytes, by Titan's firmware key
  notes       text,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  retired_at  timestamptz
);
CREATE UNIQUE INDEX firmware_releases_unique ON firmware_releases (type_id, version, coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE firmware_rollouts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id  uuid NOT NULL REFERENCES firmware_releases(id),
  org_id      uuid REFERENCES organisations(id),  -- whose devices; null = every org's devices of this type (Kitovu only)
  site_id     uuid REFERENCES sites(id),
  device_ids  text[],                         -- explicit list, or null for all matching devices
  batch_size  integer NOT NULL DEFAULT 10 CHECK (batch_size BETWEEN 1 AND 1000),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','done','cancelled')),
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE device_firmware (
  device_id   text PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  current_version text,
  rollout_id  uuid REFERENCES firmware_rollouts(id),
  release_id  uuid REFERENCES firmware_releases(id),
  state       text NOT NULL DEFAULT 'idle' CHECK (state IN ('idle','queued','sent','downloading','installed','failed')),
  command_id  text,
  detail      text,
  attempts    integer NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON device_firmware (rollout_id, state);

-- ---------- PAYG ----------
CREATE TABLE payg_plans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organisations(id),
  name        text NOT NULL,
  currency    text NOT NULL DEFAULT 'NGN',
  price_per_day numeric(14,2) NOT NULL CHECK (price_per_day > 0),
  deposit     numeric(14,2) NOT NULL DEFAULT 0,
  total_price numeric(14,2),                  -- lease-to-own: unlocks for good once paid in full; null = pay-per-use forever
  grace_hours integer NOT NULL DEFAULT 0 CHECK (grace_hours BETWEEN 0 AND 720),
  min_payment numeric(14,2) NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payg_accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organisations(id),
  device_id   text NOT NULL UNIQUE REFERENCES devices(id),
  plan_id     uuid NOT NULL REFERENCES payg_plans(id),
  code        text NOT NULL UNIQUE,           -- short payment reference customers quote, e.g. KB7F3Q
  customer_name text NOT NULL,
  customer_phone text,
  customer_email text,
  customer_ref text,                          -- the client's own customer ID
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paid_off','suspended','cancelled')),
  credit_until timestamptz NOT NULL DEFAULT now(),
  total_paid  numeric(14,2) NOT NULL DEFAULT 0,
  lock_state  text NOT NULL DEFAULT 'unknown' CHECK (lock_state IN ('unknown','locked','unlocked')),
  lock_sent_at timestamptz,
  reminded_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON payg_accounts (org_id);
CREATE INDEX ON payg_accounts (status, credit_until);

CREATE TABLE payg_payments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES payg_accounts(id),
  org_id      uuid NOT NULL,
  amount      numeric(14,2) NOT NULL CHECK (amount > 0),
  currency    text NOT NULL,
  source      text NOT NULL CHECK (source IN ('api','paystack','manual')),
  reference   text NOT NULL,
  hours_added numeric(10,2) NOT NULL,
  credit_until timestamptz NOT NULL,
  recorded_by text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, reference)
);
CREATE INDEX ON payg_payments (account_id, received_at DESC);

-- Paystack checkouts started from the public pay page (confirmed by webhook or callback).
CREATE TABLE payg_checkouts (
  reference   text PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES payg_accounts(id),
  amount      numeric(14,2) NOT NULL,
  currency    text NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE commands DROP CONSTRAINT IF EXISTS commands_source_check;
ALTER TABLE commands ADD CONSTRAINT commands_source_check CHECK (source IN ('user','api','automation','system'));

-- Titan itself may now lock and unlock PAYG appliances.
UPDATE device_types SET commands =
  '[{"name":"paygo.lock","label":"Lock appliance","args":{},"allow":["admin","api","system"]},
    {"name":"paygo.unlock","label":"Unlock appliance","args":{"until":{"type":"number","min":0}},"allow":["admin","api","system"]}]'
WHERE id = 'paygo-appliance-v1';

-- ---------- Carbon: verifiers and registries ----------
ALTER TABLE carbon_projects ADD COLUMN registry_methodology text;   -- e.g. the registry's methodology code the project is registered under
ALTER TABLE carbon_projects ADD COLUMN registry_project_id text;

CREATE TABLE verifier_assignments (
  project_id  uuid NOT NULL REFERENCES carbon_projects(id),
  verifier_org_id uuid NOT NULL REFERENCES organisations(id),
  granted_by  text NOT NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  PRIMARY KEY (project_id, verifier_org_id)
);

CREATE TABLE verification_findings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES carbon_projects(id),
  activity_id uuid REFERENCES carbon_activities(id),
  verifier_org_id uuid NOT NULL REFERENCES organisations(id),
  kind        text NOT NULL CHECK (kind IN ('clarification','corrective_action','observation')),
  text        text NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','responded','closed')),
  response    text,
  responded_by text,
  responded_at timestamptz,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz
);
CREATE INDEX ON verification_findings (project_id, status);

CREATE TABLE verification_statements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES carbon_projects(id),
  verifier_org_id uuid NOT NULL REFERENCES organisations(id),
  activity_ids uuid[] NOT NULL,
  opinion     text NOT NULL CHECK (opinion IN ('positive','qualified','negative')),
  verified_tco2e numeric(14,4) NOT NULL,
  statement   text NOT NULL,
  package_sha256 text NOT NULL,               -- fingerprint of the evidence the verifier signed off
  signed_by   text NOT NULL,
  signed_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE registry_submissions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES carbon_projects(id),
  org_id      uuid NOT NULL REFERENCES organisations(id),
  registry    text NOT NULL CHECK (registry IN ('verra','gold_standard','puro','isometric','other')),
  statement_id uuid REFERENCES verification_statements(id),
  activity_ids uuid[] NOT NULL,
  claimed_tco2e numeric(14,4) NOT NULL,
  package_sha256 text NOT NULL,
  status      text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','submitted','under_review','issued','rejected')),
  registry_ref text,
  issued_tco2e numeric(14,4),
  serial_from text,
  serial_to   text,
  notes       text,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  decided_at  timestamptz
);

-- ---------- GradeGuard: quality specs, tests and traceability ----------
CREATE TABLE quality_specs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organisations(id),
  name        text NOT NULL,                  -- e.g. "Olam paddy grade 1"
  buyer       text,
  commodity   text NOT NULL,
  -- [{"key":"moisture","label":"Moisture","unit":"%","min":null,"max":14}, ...]
  parameters  jsonb NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organisations(id),
  code        text NOT NULL,                  -- printed on the bag tag / QR
  commodity   text NOT NULL,
  quantity    numeric(14,3),
  unit        text NOT NULL DEFAULT 'kg',
  origin      text,                           -- farmer, cooperative or community
  origin_lat  double precision,
  origin_lng  double precision,
  harvested_on date,
  site_id     uuid REFERENCES sites(id),      -- where it is now
  stack_id    uuid REFERENCES stacks(id),
  parent_ids  uuid[] NOT NULL DEFAULT '{}',   -- lots merged into this one
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','stored','dispatched','closed')),
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, code)
);

CREATE TABLE quality_tests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organisations(id),
  lot_id      uuid REFERENCES lots(id),
  spec_id     uuid REFERENCES quality_specs(id),
  site_id     uuid REFERENCES sites(id),
  device_id   text REFERENCES devices(id),    -- GradeGuard unit, if measured by one
  sample_ref  text,
  commodity   text NOT NULL,
  results     jsonb NOT NULL,                 -- {"moisture": 13.2, "foreign_matter": 1.1}
  outcome     text NOT NULL CHECK (outcome IN ('pass','fail','no_spec')),
  failures    jsonb NOT NULL DEFAULT '[]',
  lat         double precision,
  lng         double precision,
  tested_at   timestamptz NOT NULL,
  tested_by   text NOT NULL,
  client_ref  text,                           -- offline app's own ID, so re-sent tests are not duplicated
  device_seq  bigint,                         -- signed device message it came from
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, client_ref)
);
CREATE INDEX ON quality_tests (org_id, tested_at DESC);
CREATE INDEX ON quality_tests (lot_id);

CREATE TABLE custody_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organisations(id),
  lot_id      uuid NOT NULL REFERENCES lots(id),
  kind        text NOT NULL CHECK (kind IN ('created','aggregated','tested','received','stored','moved','dispatched','delivered','merged','note')),
  site_id     uuid REFERENCES sites(id),
  stack_id    uuid REFERENCES stacks(id),
  counterparty text,
  quantity    numeric(14,3),
  note        text,
  lat         double precision,
  lng         double precision,
  at          timestamptz NOT NULL DEFAULT now(),
  recorded_by text NOT NULL,
  client_ref  text,
  UNIQUE (org_id, client_ref)
);
CREATE INDEX ON custody_events (lot_id, at);

INSERT INTO device_types (id, name, defaults, commands) VALUES
  ('gradeguard-v1', 'GradeGuard v1',
   '{"wifi":{"telemetry_s":3600,"heartbeat_s":3600},"gsm":{"telemetry_s":3600,"heartbeat_s":21600}}', '[]')
ON CONFLICT (id) DO NOTHING;

INSERT INTO metrics (key, unit, label, kind, min_valid, max_valid, derived) VALUES
  ('sample.moisture',        '%',   'Sample moisture',          'gauge', 0, 100, false),
  ('sample.temperature',     '°C',  'Sample temperature',       'gauge', -20, 80, false),
  ('sample.foreign_matter',  '%',   'Foreign matter',           'gauge', 0, 100, false),
  ('sample.broken',          '%',   'Broken grains',            'gauge', 0, 100, false),
  ('sample.discoloured',     '%',   'Discoloured grains',       'gauge', 0, 100, false),
  ('sample.aflatoxin',       'ppb', 'Aflatoxin',                'gauge', 0, 10000, false),
  ('sample.hectolitre_mass', 'kg/hl','Hectolitre mass',         'gauge', 0, 120, false)
ON CONFLICT (key) DO NOTHING;

-- ---------- Monitoring ----------
CREATE TABLE system_heartbeats (
  name        text PRIMARY KEY,               -- worker name
  beat_at     timestamptz NOT NULL DEFAULT now(),
  detail      jsonb
);

COMMIT;
