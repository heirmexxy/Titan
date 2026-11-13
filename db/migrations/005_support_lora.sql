-- Kitovu support sessions in client consoles, and LoRa gateway relaying.
BEGIN;

-- A support session: a Kitovu admin/ops user acting inside a client's console.
ALTER TABLE sessions ADD COLUMN acting_org_id uuid REFERENCES organisations(id);
ALTER TABLE sessions ADD COLUMN reason text;

-- Nodes that reach Titan through a LoRa gateway.
ALTER TABLE devices ADD COLUMN gateway_id text REFERENCES devices(id);
CREATE INDEX ON devices (gateway_id);

INSERT INTO device_types (id, name, defaults, commands) VALUES
  ('titan-lora-gateway-v1', 'Titan LoRa Gateway v1',
   '{"wifi":{"telemetry_s":300,"heartbeat_s":60},"gsm":{"telemetry_s":300,"heartbeat_s":120}}', '[]');

COMMIT;
