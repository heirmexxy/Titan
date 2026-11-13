-- Operations agent: incidents (grouped alerts), sensor health findings, reports and drafted messages.
BEGIN;

CREATE TABLE incidents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL,                 -- cause + scope, e.g. power_outage:<site>
  org_id      uuid NOT NULL REFERENCES organisations(id),
  site_id     uuid REFERENCES sites(id),
  cause       text NOT NULL,                 -- gateway_down | power_outage | site_connectivity | site_condition
  title       text NOT NULL,
  summary     text NOT NULL,
  alert_ids   uuid[] NOT NULL DEFAULT '{}',
  device_ids  text[] NOT NULL DEFAULT '{}',
  severity    text NOT NULL DEFAULT 'warning',
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  opened_at   timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  notified_at timestamptz
);
CREATE UNIQUE INDEX incidents_open_key ON incidents (key) WHERE status = 'open';
CREATE INDEX ON incidents (org_id, opened_at DESC);

CREATE TABLE sensor_findings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL,                 -- kind:device:channel:metric
  org_id      uuid NOT NULL REFERENCES organisations(id),
  site_id     uuid,
  device_id   text NOT NULL,
  channel     text,
  metric      text,
  kind        text NOT NULL,                 -- stuck | spikes | drift | tamper | seq_reset | clock | gaps
  severity    text NOT NULL DEFAULT 'warning',
  title       text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}',
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','dismissed','cleared')),
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sensor_findings_open_key ON sensor_findings (key) WHERE status = 'open';

CREATE TABLE reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organisations(id),
  period      text NOT NULL,                 -- 2026-11
  data        jsonb NOT NULL,
  narrative   text,
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent')),
  sent_at     timestamptz,
  sent_to     text[],
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, period)
);

CREATE TABLE drafted_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organisations(id),
  incident_id uuid REFERENCES incidents(id),
  report_id   uuid REFERENCES reports(id),
  subject     text NOT NULL,
  body        text NOT NULL,
  written_by  text NOT NULL,                 -- template | claude
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','discarded')),
  sent_to     text[],
  sent_by     uuid,
  sent_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMIT;
