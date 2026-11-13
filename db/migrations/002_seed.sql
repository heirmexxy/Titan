-- Titan v1 seed data: metric registry, crop profiles, WareGuard device type, Kitovu organisation.
BEGIN;

INSERT INTO metrics (key, unit, label, kind, min_valid, max_valid, derived) VALUES
  ('air.temperature',        '°C',      'Air temperature',            'gauge',  -40, 85,    false),
  ('air.humidity',           '%RH',     'Relative humidity',          'gauge',  0,   100,   false),
  ('air.dew_point',          '°C',      'Dew point',                  'gauge',  -60, 85,    true),
  ('air.vpd',                'kPa',     'Vapour pressure deficit',    'gauge',  0,   10,    true),
  ('air.co2',                'ppm',     'CO₂',                        'gauge',  0,   40000, false),
  ('air.o2',                 '%',       'Oxygen',                     'gauge',  0,   25,    false),
  ('air.ethylene',           'ppm',     'Ethylene',                   'gauge',  0,   1000,  false),
  ('air.ammonia',            'ppm',     'Ammonia',                    'gauge',  0,   1000,  false),
  ('air.phosphine',          'ppm',     'Phosphine',                  'gauge',  0,   5000,  false),
  ('air.smoke',              'state',   'Smoke',                      'binary', 0,   1,     false),
  ('air.pm25',               'µg/m³',   'PM2.5',                      'gauge',  0,   2000,  false),
  ('air.light',              'lux',     'Light',                      'gauge',  0,   200000,false),
  ('produce.moisture',       '% wb',    'Produce moisture',           'gauge',  0,   60,    false),
  ('produce.moisture_raw',   'raw',     'Produce moisture (raw)',     'gauge',  NULL,NULL,  false),
  ('produce.emc',            '% wb',    'Equilibrium moisture',       'gauge',  0,   60,    true),
  ('produce.temperature',    '°C',      'Produce core temperature',   'gauge',  -20, 80,    false),
  ('produce.weight',         'kg',      'Weight',                     'gauge',  0,   NULL,  false),
  ('produce.level',          '%',       'Fill level',                 'gauge',  0,   100,   false),
  ('produce.insect_activity','count/h', 'Insect activity',            'gauge',  0,   NULL,  false),
  ('security.motion',        'state',   'Motion',                     'binary', 0,   1,     false),
  ('security.door',          'state',   'Door open',                  'binary', 0,   1,     false),
  ('security.tamper',        'state',   'Tamper',                     'binary', 0,   1,     false),
  ('water.temperature',      '°C',      'Water temperature',          'gauge',  -5,  60,    false),
  ('water.ph',               'pH',      'pH',                         'gauge',  0,   14,    false),
  ('water.ec',               'mS/cm',   'Electrical conductivity',    'gauge',  0,   20,    false),
  ('water.tds',              'ppm',     'Total dissolved solids',     'gauge',  0,   10000, false),
  ('water.do',               'mg/L',    'Dissolved oxygen',           'gauge',  0,   25,    false),
  ('water.orp',              'mV',      'ORP',                        'gauge',  -1000,1000, false),
  ('water.ammonia',          'mg/L',    'Ammonia (water)',            'gauge',  0,   100,   false),
  ('water.nitrite',          'mg/L',    'Nitrite',                    'gauge',  0,   100,   false),
  ('water.nitrate',          'mg/L',    'Nitrate',                    'gauge',  0,   1000,  false),
  ('water.turbidity',        'NTU',     'Turbidity',                  'gauge',  0,   4000,  false),
  ('water.level',            'cm',      'Water level',                'gauge',  0,   NULL,  false),
  ('water.flow',             'L/min',   'Flow rate',                  'gauge',  0,   NULL,  false),
  ('soil.moisture',          '%VWC',    'Soil moisture',              'gauge',  0,   100,   false),
  ('soil.temperature',       '°C',      'Soil temperature',           'gauge',  -20, 70,    false),
  ('power.mains',            'state',   'Mains power',                'binary', 0,   1,     false),
  ('power.voltage',          'V',       'Voltage',                    'gauge',  0,   500,   false),
  ('power.current',          'A',       'Current',                    'gauge',  0,   500,   false),
  ('power.energy',           'kWh',     'Energy',                     'counter',0,   NULL,  false),
  ('power.battery_soc',      '%',       'Battery charge',             'gauge',  0,   100,   false),
  ('equipment.state',        'state',   'Equipment running',          'binary', 0,   1,     false),
  ('equipment.runtime',      'h',       'Equipment runtime',          'counter',0,   NULL,  false),
  ('weather.rain',           'mm',      'Rainfall',                   'gauge',  0,   500,   false),
  ('weather.wind_speed',     'm/s',     'Wind speed',                 'gauge',  0,   80,    false),
  ('weather.solar_radiation','W/m²',    'Solar radiation',            'gauge',  0,   1500,  false);

-- Modified Henderson parameters (ASAE D245 form: 1-RH = exp(-K (T + C) M^N), M in % dry basis).
-- VERIFY against your calibration source before relying on EMC for credit decisions.
INSERT INTO crop_profiles (crop, label, henderson_k, henderson_n, henderson_c, safe_moisture) VALUES
  ('maize',   'Maize (shelled)', 8.6541e-5,  1.8634, 49.810,  13.0),
  ('paddy',   'Rice (paddy)',    1.9187e-5,  2.4451, 51.161,  14.0),
  ('soybean', 'Soybean',         30.5327e-5, 1.2164, 134.136, 12.0),
  ('sorghum', 'Sorghum',         0.8532e-4,  2.4757, 113.725, 13.0),
  ('wheat',   'Wheat',           2.3007e-5,  2.2857, 55.815,  13.0),
  ('sesame',  'Sesame',          NULL,       NULL,   NULL,    7.0);

INSERT INTO organisations (name, kind, billing_email, device_prefix)
VALUES ('Kitovu Technology Company Limited', 'kitovu', 'titan@kitovu.com.ng', 'WG');

INSERT INTO device_types (id, name, manufacturer_org_id, defaults)
SELECT 'wareguard-v1', 'WareGuard v1', id,
  '{"wifi":{"telemetry_s":10,"moisture_s":60,"heartbeat_s":60},
    "gsm":{"telemetry_s":60,"moisture_s":300,"heartbeat_s":300}}'::jsonb
FROM organisations WHERE device_prefix = 'WG';

COMMIT;
