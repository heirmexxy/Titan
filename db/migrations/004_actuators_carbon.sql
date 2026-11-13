-- Actuators (command catalogue, policies, automations, command log) and the carbon module.
BEGIN;

-- ---------- Actuators ----------
-- Command catalogue per device type:
-- [{"name":"relay.set","label":"Switch relay","args":{"channel":{"type":"string"},"on":{"type":"boolean"}},
--   "allow":["admin","ops","api","automation"]}]
ALTER TABLE device_types ADD COLUMN commands jsonb NOT NULL DEFAULT '[]';

CREATE TABLE commands (
  id          text PRIMARY KEY,               -- c_xxxxxxxx, sent to the device
  device_id   text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  org_id      uuid NOT NULL,
  name        text NOT NULL,
  args        jsonb NOT NULL DEFAULT '{}',
  source      text NOT NULL CHECK (source IN ('user','api','automation')),
  actor       text NOT NULL,                  -- user:<id> | apikey:<id> | automation:<id>
  status      text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','acked','failed')),
  result      text,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  acked_at    timestamptz
);
CREATE INDEX ON commands (device_id, sent_at DESC);

CREATE TABLE automations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organisations(id),
  name          text NOT NULL,
  site_id       uuid REFERENCES sites(id),
  source_device_id text REFERENCES devices(id),   -- null = any device in scope
  channel       text,
  metric        text NOT NULL REFERENCES metrics(key),
  op            text NOT NULL CHECK (op IN ('gt','lt')),
  threshold     double precision NOT NULL,
  duration_s    integer NOT NULL DEFAULT 0,
  hysteresis    double precision NOT NULL DEFAULT 0,
  target_device_id text NOT NULL REFERENCES devices(id),
  command       text NOT NULL,
  args          jsonb NOT NULL DEFAULT '{}',
  clear_command text,                              -- sent when the condition clears (optional)
  clear_args    jsonb NOT NULL DEFAULT '{}',
  cooldown_s    integer NOT NULL DEFAULT 300,
  enabled       boolean NOT NULL DEFAULT true,
  last_fired_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE automation_state (
  automation_id uuid NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  device_id     text NOT NULL,
  channel       text NOT NULL,
  breach_since  timestamptz,
  active        boolean NOT NULL DEFAULT false,
  PRIMARY KEY (automation_id, device_id, channel)
);

-- Generic controller and PAYG appliance types with command catalogues.
INSERT INTO device_types (id, name, defaults, commands) VALUES
  ('titan-controller-v1', 'Titan Controller v1',
   '{"wifi":{"telemetry_s":30,"heartbeat_s":60},"gsm":{"telemetry_s":120,"heartbeat_s":300}}',
   '[{"name":"relay.set","label":"Switch output","args":{"channel":{"type":"string"},"on":{"type":"boolean"}},"allow":["admin","ops","api","automation"]},
     {"name":"setpoint.set","label":"Set target","args":{"channel":{"type":"string"},"value":{"type":"number","min":-50,"max":1000}},"allow":["admin","ops","api","automation"]}]'),
  ('paygo-appliance-v1', 'PAYG appliance v1',
   '{"wifi":{"telemetry_s":300,"heartbeat_s":900},"gsm":{"telemetry_s":900,"heartbeat_s":3600}}',
   '[{"name":"paygo.lock","label":"Lock appliance","args":{},"allow":["admin","api"]},
     {"name":"paygo.unlock","label":"Unlock appliance","args":{"until":{"type":"number","min":0}},"allow":["admin","api"]}]');

-- ---------- Data retention per organisation ----------
ALTER TABLE organisations ADD COLUMN retention_days integer NOT NULL DEFAULT 730 CHECK (retention_days BETWEEN 30 AND 7300);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM remove_retention_policy('readings', if_exists => true);
  END IF;
END $$;

-- ---------- Carbon ----------
CREATE TABLE carbon_projects (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organisations(id),
  name         text NOT NULL,
  methodology  text NOT NULL CHECK (methodology IN ('biochar-v1','cookstove-v1')),
  registry     text,                          -- e.g. Puro.earth, Verra, Gold Standard (informational)
  site_ids     uuid[] NOT NULL DEFAULT '{}',
  params       jsonb NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','closed')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- A biochar batch, a cookstove reporting period, etc.
CREATE TABLE carbon_activities (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES carbon_projects(id),
  org_id       uuid NOT NULL,
  site_id      uuid,
  device_id    text,
  kind         text NOT NULL CHECK (kind IN ('batch','period')),
  reference    text,                          -- operator's batch number
  started_at   timestamptz NOT NULL,
  ended_at     timestamptz,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','calculated','rejected')),
  result       jsonb,                         -- calculation output incl. inputs and lineage
  calculated_at timestamptz,
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON carbon_activities (project_id, started_at DESC);

-- Manual and lab measurements. Never edited: corrections are new rows that supersede old ones.
CREATE TABLE carbon_measurements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES carbon_projects(id),
  activity_id  uuid REFERENCES carbon_activities(id),
  kind         text NOT NULL,                 -- see src/carbon/methodologies.ts
  value        double precision NOT NULL,
  unit         text NOT NULL,
  sampled_at   timestamptz,
  document_ref text,                          -- lab certificate file name or URL
  document_sha256 text,                       -- hash of the certificate file
  note         text,
  supersedes_id uuid REFERENCES carbon_measurements(id),
  entered_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON carbon_measurements (activity_id);

-- New metrics for sensor nodes
INSERT INTO metrics (key, unit, label, kind, min_valid, max_valid, derived) VALUES
  ('kiln.temperature',     '°C',   'Kiln temperature',          'gauge',  -20, 1300, false),
  ('feedstock.mass',       'kg',   'Feedstock mass',            'gauge',  0,   NULL, false),
  ('biochar.mass',         'kg',   'Biochar mass',              'gauge',  0,   NULL, false),
  ('feedstock.moisture',   '%',    'Feedstock moisture',        'gauge',  0,   100,  false),
  ('stove.temperature',    '°C',   'Stove body temperature',    'gauge',  -20, 600,  false),
  ('stove.energy',         'kWh',  'Cooking energy (electric)', 'counter',0,   NULL, false),
  ('lpg.mass',             'kg',   'LPG cylinder mass',         'gauge',  0,   100,  false),
  ('solar.energy',         'kWh',  'Solar energy produced',     'counter',0,   NULL, false),
  ('solar.power',          'W',    'Solar power',               'gauge',  0,   NULL, false),
  ('appliance.locked',     'state','Appliance locked',          'binary', 0,   1,    false),
  ('appliance.door_opens', 'count','Door openings',             'counter',0,   NULL, false),
  ('location.lat',         '°',    'Latitude',                  'gauge',  -90, 90,   false),
  ('location.lng',         '°',    'Longitude',                 'gauge',  -180,180,  false);

INSERT INTO device_types (id, name, defaults) VALUES
  ('titan-kiln-v1', 'Titan Kiln Node v1', '{"wifi":{"telemetry_s":30,"heartbeat_s":60},"gsm":{"telemetry_s":60,"heartbeat_s":300}}'),
  ('titan-cookstove-v1', 'Titan Cookstove Node v1', '{"wifi":{"telemetry_s":120,"heartbeat_s":3600},"gsm":{"telemetry_s":120,"heartbeat_s":21600}}'),
  ('titan-solar-v1', 'Titan Solar Node v1', '{"wifi":{"telemetry_s":300,"heartbeat_s":900},"gsm":{"telemetry_s":900,"heartbeat_s":3600}}');

COMMIT;
