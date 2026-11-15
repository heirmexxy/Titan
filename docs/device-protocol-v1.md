# Titan Device Protocol v1

**Status:** Draft for hardware review · **Owner:** Kitovu Technology Company Limited · **Applies to:** WareGuard and any third-party device connecting to Titan (`titan.kitovu.com.ng`)

This document defines how devices connect to Titan, sign their readings, and receive configuration and commands. Sensor acquisition, displays and offline local alarms are up to each device and are not covered here.

---

## 1. At a glance

| Topic | Titan v1 |
|---|---|
| Broker | `mqtt.titan.kitovu.com.ng:8883` (TLS 1.2+), WebSocket fallback on 443 |
| Authentication | Username = device ID, password = device token issued at provisioning |
| Message integrity | **Every uplink message is signed with the device's own Ed25519 key** |
| Topics | `titan/v1/<deviceId>/up/<kind>` and `titan/v1/<deviceId>/down/<kind>` |
| Payload | One signed envelope carrying many readings |
| Metric names | Registry keys such as `air.temperature`, `air.humidity` (§5) |
| Ordering and duplicates | Monotonic sequence number `seq` |
| Moisture | Raw value **and** calibrated value with its calibration profile ID |
| Reporting intervals | Set in Titan and pushed to the device (`down/config`) |

---

## 2. Connection

| Parameter | Value |
|---|---|
| Host | `mqtt.titan.kitovu.com.ng` |
| Port | `8883` (MQTT over TLS). Port `443` WebSocket (`wss://mqtt.titan.kitovu.com.ng/mqtt`) for networks that block 8883 |
| MQTT version | 3.1.1 (5.0 accepted) |
| Client ID | Device ID, e.g. `WG-000123` |
| Username | Device ID |
| Password | Device token (issued at provisioning, 32 bytes, base64url) |
| Keepalive | 60 s (Wi-Fi), 120 s (GSM) |
| Clean session | `false` (so QoS 1 downlinks queued while offline are delivered on reconnect) |
| TLS | Must validate server certificate chain (ISRG Root X1 — Let's Encrypt). Pin the root, not the leaf |
| Last Will | Topic `titan/v1/<deviceId>/up/lwt`, payload `offline`, QoS 1, retain false |

**Device ID format:** `<PREFIX>-<6+ digits>`. WareGuard uses `WG-`. Third-party manufacturers are assigned their own prefix at onboarding.

**GSM note:** use a modem with native TLS 1.2 (e.g. SIMCom A7670 / SIM7600 class). SIM800-class modems cannot do modern TLS reliably and are not supported.

---

## 3. Topics

Uplink (device → Titan), all QoS 1:

| Topic | Purpose |
|---|---|
| `titan/v1/<deviceId>/up/telemetry` | Routine readings (batched) |
| `titan/v1/<deviceId>/up/event` | Immediate events (intruder, threshold breach, sensor fault) |
| `titan/v1/<deviceId>/up/state` | Heartbeat / device health |
| `titan/v1/<deviceId>/up/ack` | Acknowledges a config or command |
| `titan/v1/<deviceId>/up/lwt` | Last Will (set at connect; not sent manually) |

Downlink (Titan → device). The device subscribes to `titan/v1/<deviceId>/down/#`, QoS 1:

| Topic | Purpose |
|---|---|
| `titan/v1/<deviceId>/down/config` | Full configuration document (retained) |
| `titan/v1/<deviceId>/down/cmd` | One-off commands (acknowledge alarm, reboot, sync time) |

The broker enforces that a device can only publish and subscribe under its own `<deviceId>`.

---

## 4. Uplink envelope

Every uplink payload (except `lwt`) is a small JSON wrapper:

```json
{"k":"k1","p":"<base64url(body)>","s":"<base64url(signature)>"}
```

| Field | Meaning |
|---|---|
| `k` | Key ID of the signing key (lets keys be rotated) |
| `p` | The **body**, a UTF-8 JSON document, base64url-encoded (no padding) |
| `s` | Ed25519 signature over the exact bytes of the decoded body, base64url (no padding) |

Signing the exact body bytes means there is no JSON canonicalisation problem: the device signs whatever string it produced, and Titan verifies those same bytes. Titan stores the original `p` and `s` so any reading can later be re-verified by a third party (lender, auditor) using the device's public key.

### 4.1 Body

```json
{
  "v": 1,
  "dev": "WG-000123",
  "seq": 1042,
  "ts": 1763022600,
  "up": 86400123,
  "buf": false,
  "fw": "1.3.0",
  "r": [
    {"m": "air.temperature", "v": 28.5, "ch": "z1/dht22"},
    {"m": "air.humidity", "v": 74.2, "ch": "z1/dht22"},
    {"m": "produce.moisture_raw", "v": 2310, "ch": "z1/stack-a/mst1"},
    {"m": "produce.moisture", "v": 12.8, "ch": "z1/stack-a/mst1", "cal": "maize-cap-v2"},
    {"m": "security.motion", "v": 0, "ch": "z1/pir1"}
  ]
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `v` | int | yes | Body version, `1` |
| `dev` | string | yes | Device ID. Must match the MQTT username |
| `seq` | uint32 | yes | Message sequence number. Increments by 1 for **every** uplink message, persisted in flash across reboots. Never reused |
| `ts` | int | yes | Time the readings were taken, Unix seconds UTC. `0` if the clock has never been synced |
| `up` | int | yes | Milliseconds since boot when the readings were taken |
| `upn` | int | if `ts`=0 | Milliseconds since boot at the moment of sending. Lets Titan estimate `ts` when the clock was not synced |
| `buf` | bool | yes | `true` if this message was stored during an outage and is being sent late |
| `fw` | string | no | Firmware version (send at least in `state`) |
| `r` | array | telemetry/event | Readings (Section 4.2) |
| `ev` | object | event | Event (Section 6) |
| `st` | object | state | Device health (Section 7) |
| `ack` | object | ack | Acknowledgement (Section 8) |

### 4.2 Readings

| Field | Type | Required | Meaning |
|---|---|---|---|
| `m` | string | yes | Metric key from the Titan metric registry (Section 5) |
| `v` | number | yes | Value in the metric's canonical unit (no unit conversion on the device beyond the canonical unit) |
| `ch` | string | yes | Channel: where the sensor is, as `zone/stack/sensor` or `zone/sensor`. Titan maps channels to warehouse zones and stacks |
| `cal` | string | for calibrated values | Calibration profile ID used to produce `v` |
| `q` | string | no | Device-side quality flag: `ok` (default), `suspect`, `fault` |

**Moisture rule:** always send both `produce.moisture_raw` (the sensor's raw reading) and `produce.moisture` (calibrated, % wet basis) with the `cal` profile ID. If a calibration curve is later corrected, Titan can recompute history from the raw value.

### 4.3 Signing (Ed25519)

1. Build the body JSON string `B` (any key order and whitespace).
2. `sig = Ed25519_sign(device_private_key, bytes(B))`.
3. Publish `{"k":"<keyId>","p":base64url(B),"s":base64url(sig)}`.

Implementation notes for ESP32:

- Use Monocypher or libsodium (`crypto_sign_detached`). Signing takes a few milliseconds on ESP32.
- The private key is generated **on the device** at provisioning and stored in an **encrypted NVS partition** (ESP32 flash encryption + secure boot v2 enabled in production builds). Only the public key leaves the device.
- Base64url: standard base64 with `+`→`-`, `/`→`_`, padding `=` removed.

Third-party devices that cannot do Ed25519 may be approved for `HMAC-SHA256` (key ID prefix `h`), but readings from those devices are labelled *integrity: shared-secret* rather than *integrity: device-signed* in the API.

### 4.4 What Titan does with each message

1. Checks the MQTT username matches `dev`.
2. Verifies the signature against the registered public key for `k`. Fails → message rejected and logged as a tamper event.
3. Drops duplicates by (`dev`, `seq`).
4. Validates each reading against the metric registry (known metric, numeric, within plausible range). Out-of-range values are stored with quality `rejected` rather than silently dropped.
5. Labels readings `live` or `buffered`, and `time_estimated` if `ts` was 0.
6. Adds derived metrics (dew point, equilibrium moisture content, safe-storage indicators).
7. Evaluates alert rules and meters usage.

---

## 5. Metric registry (initial)

Device firmware must use these keys and units. New metrics are added by Titan admins; devices should never invent keys.

| Key | Unit | Notes |
|---|---|---|
| `air.temperature` | °C | Ambient |
| `air.humidity` | %RH | Ambient |
| `air.co2` | ppm | Spoilage / insect respiration indicator |
| `air.o2` | % | |
| `air.ethylene` | ppm | |
| `air.ammonia` | ppm | |
| `air.phosphine` | ppm | Fumigation safety |
| `air.smoke` | 0/1 | |
| `air.pm25` | µg/m³ | |
| `air.light` | lux | |
| `produce.moisture` | % wet basis | Calibrated, with `cal` |
| `produce.moisture_raw` | raw counts | Sensor-specific |
| `produce.temperature` | °C | Core/stack temperature (temperature cables) |
| `produce.weight` | kg | Load cells |
| `produce.level` | % | Bin/silo fill |
| `produce.insect_activity` | count/h | Acoustic probes or traps |
| `security.motion` | 0/1 | PIR state |
| `security.door` | 0/1 | 1 = open |
| `security.tamper` | 0/1 | Enclosure/vibration |
| `water.temperature` | °C | Aquaponics/hydroponics |
| `water.ph` | pH | |
| `water.ec` | mS/cm | |
| `water.tds` | ppm | |
| `water.do` | mg/L | Dissolved oxygen |
| `water.orp` | mV | |
| `water.ammonia` | mg/L | |
| `water.nitrite` | mg/L | |
| `water.nitrate` | mg/L | |
| `water.turbidity` | NTU | |
| `water.level` | cm | |
| `water.flow` | L/min | |
| `soil.moisture` | %VWC | |
| `soil.temperature` | °C | |
| `power.mains` | 0/1 | |
| `power.voltage` | V | |
| `power.current` | A | |
| `power.energy` | kWh | Cumulative |
| `power.battery_soc` | % | Solar/backup battery |
| `equipment.state` | 0/1 | Fan, pump, aerator; channel names the equipment |
| `equipment.runtime` | h | Cumulative |
| `kiln.temperature` | °C | One channel per probe, e.g. `k1/top`, `k1/bottom` |
| `feedstock.mass` | kg | One reading per weighing |
| `feedstock.moisture` | % | |
| `biochar.mass` | kg | One reading per weighed bag/load; Titan sums them per batch |
| `stove.temperature` | °C | Stove body probe, for cooking-session detection |
| `stove.energy` | kWh | Electric cooking, cumulative |
| `lpg.mass` | kg | LPG cylinder on a scale |
| `solar.energy` | kWh | Cumulative from inverter or charge controller |
| `solar.power` | W | |
| `appliance.locked` | 0/1 | PAYG lock state |
| `appliance.door_opens` | count | Cumulative |
| `location.lat` / `location.lng` | ° | Mobile assets |
| `weather.rain` | mm | |
| `weather.wind_speed` | m/s | |
| `weather.solar_radiation` | W/m² | |

Device-health values (battery, signal, uptime) go in `state` messages, not as readings.

---

## 6. Events (`up/event`)

Send immediately; do not wait for the next telemetry cycle.

```json
{
  "v": 1, "dev": "WG-000123", "seq": 1043, "ts": 1763022611, "up": 86411002, "buf": false,
  "ev": {"code": "intruder_detected", "ch": "z1/pir1", "sev": "critical", "msg": "Motion detected"},
  "r": [{"m": "security.motion", "v": 1, "ch": "z1/pir1"}]
}
```

| Code | Trigger |
|---|---|
| `intruder_detected` | PIR motion state 0 → 1 (send again only after it returns to 0) |
| `door_opened` | Door contact opens |
| `tamper_detected` | Enclosure opened / vibration |
| `threshold_breach` | Device-side threshold exceeded (Titan also evaluates thresholds independently) |
| `sensor_error` | Sensor missing, out of range, or read failure. `ch` names the sensor |
| `power_lost` / `power_restored` | Mains state change |
| `boot` | Device started (include reset reason in `msg`) |
| `batch_start` / `batch_end` | Kiln and batch-process nodes: operator pressed start/end. `msg` carries the batch number. Titan opens and closes the carbon batch automatically |

Severity `sev`: `info`, `warning`, `critical`.

---

## 7. Heartbeat (`up/state`)

Send on connect and every `heartbeat_s` seconds (from config).

```json
{
  "v": 1, "dev": "WG-000123", "seq": 1044, "ts": 1763022660, "up": 86460000, "buf": false, "fw": "1.3.0",
  "st": {"net": "wifi", "rssi": -67, "bat": 4.02, "heap": 142000, "bufq": 0, "cfg": 7, "time": "ntp", "err": []}
}
```

| Field | Meaning |
|---|---|
| `net` | `wifi` or `gsm` |
| `rssi` | Signal strength, dBm |
| `bat` | Battery voltage (omit if mains only) |
| `heap` | Free heap bytes |
| `bufq` | Messages waiting in the offline buffer |
| `cfg` | Config version currently applied |
| `time` | Clock source: `ntp`, `gsm`, `rtc`, `none` |
| `err` | Active sensor fault codes |

Titan marks a device **offline** if no message arrives within `3 × heartbeat_s`, or immediately when the broker reports the connection dropped.

---

## 8. Configuration and commands (downlink)

### 8.1 Config (`down/config`, retained)

Titan publishes the **whole** config document whenever an admin changes anything. Because it is retained, a device receives the latest config every time it connects.

```json
{
  "v": 1,
  "cfg": 8,
  "interval": {"telemetry_s": 10, "moisture_s": 60, "heartbeat_s": 60},
  "thresholds": {
    "air.temperature": {"max": 35},
    "air.humidity": {"max": 75},
    "produce.moisture": {"max": 13.5}
  },
  "alarm_enable": true,
  "cal": {"z1/stack-a/mst1": "maize-cap-v2"},
  "time": 1763022700
}
```

Reporting intervals are set by Titan admins per device type, per connection type (Wi-Fi/GSM), with optional per-device overrides. The device must apply the new config and reply with an `ack` carrying the `cfg` number. Titan shows a config as *pending* until it is acknowledged.

### 8.2 Commands (`down/cmd`, not retained)

```json
{"v": 1, "id": "c_8f2a", "cmd": "alarm_ack", "args": {"code": "intruder_detected"}}
```

| `cmd` | Action |
|---|---|
| `alarm_ack` | Silence the local alarm for the given event |
| `reboot` | Restart the device |
| `time_sync` | `args.time` = current Unix time; set the clock |
| `send_state` | Publish a `state` message now |

Device types can also declare their own commands (for example `relay.set {channel, on}` on a controller, or `paygo.lock` / `paygo.unlock {until}` on a pay-as-you-go appliance). Titan only sends a command the device's type lists, with arguments already checked against that list, and records who sent it (a person, an API key or an automation). The device must reply to every command with an `ack` carrying its `id`, `ok: false` and a short `msg` if it could not act.

Actuating devices must keep a safe state if the connection is lost: a relay switched on by an automation should fall back to its configured default after `failsafe_s` seconds without contact (set per device in config; `0` disables it).

### 8.3 Acknowledgement (`up/ack`)

```json
{"v": 1, "dev": "WG-000123", "seq": 1045, "ts": 1763022702, "up": 86502000, "buf": false,
 "ack": {"cfg": 8, "ok": true}}
```

For a command: `"ack": {"id": "c_8f2a", "ok": true, "msg": ""}`.

---

## 9. Offline operation and buffering

- Sensor reading, LCD updates and local alarms continue with no connection.
- While offline, signed telemetry and event messages are stored in a flash ring buffer (recommended minimum: 72 hours at the configured interval). If the buffer fills, drop the **oldest telemetry first; never drop events**.
- Messages are signed **when created**, not when sent, so buffered data carries the original time and signature.
- On reconnect: publish `state` first, then buffered messages oldest first with `buf: true`, at most 5 messages per second, then resume live reporting.
- Reconnect with exponential backoff: 5 s, 10 s, 20 s… capped at 5 minutes, with random jitter.

## 10. Time

- Wi-Fi: NTP (`pool.ntp.org`, `time.google.com`) at boot and every 6 hours.
- GSM: network time (`AT+CCLK?`) or NTP over the data link.
- A battery-backed RTC (e.g. DS3231) is strongly recommended so buffered readings keep correct time across power cuts.
- If the clock is unsynced, send `ts: 0` plus `up` and `upn`; Titan estimates the time and marks those readings `time_estimated`.

## 11. Provisioning

1. Titan admin registers the device (ID, type, organisation, site) and receives a one-time **provisioning code**.
2. On first boot in provisioning mode, the device generates its Ed25519 key pair, then calls `POST https://titan.kitovu.com.ng/api/provision` with `{deviceId, code, publicKey}` over TLS.
3. Titan returns the MQTT device token and key ID `k1`. The code cannot be reused.
4. Production firmware is built with flash encryption and secure boot enabled, so the key and token cannot be read off the chip.

Key rotation: Titan admin issues a new provisioning code; the device generates `k2`; readings signed with `k1` remain verifiable forever.

## 12. HTTPS fallback

Devices that cannot use MQTT may `POST https://titan.kitovu.com.ng/api/ingest` with the same envelope as the body, header `Authorization: Device <deviceId>:<token>`, and header `X-Titan-Kind: telemetry|event|state|ack`. Config is fetched with `GET /api/device/config`. MQTT is preferred because downlinks are instant.

## 13. Defaults for WareGuard

| Setting | Wi-Fi | GSM |
|---|---|---|
| `telemetry_s` (temperature, humidity) | 10 | 60 |
| `moisture_s` | 60 | 300 |
| `heartbeat_s` | 60 | 300 |
| Motion | On state change only | On state change only |

All values are editable in the Titan admin panel.

## 14. v1.1 additions: LoRa gateways and compact readings

**Gateway relaying.** A LoRa gateway (`titan-lora-gateway-v1`) connects to the broker with its own credentials. For each node assigned to it in Titan, it may:
- publish the node's signed envelopes, unchanged, to `titan/v1/<nodeId>/up/telemetry|event|state|ack`
- subscribe to `titan/v1/<nodeId>/down/#` and forward configs and commands over LoRa

It may not publish a node's `up/lwt`, and it cannot publish for unassigned nodes. Titan verifies every relayed message against the **node's** key, so a gateway can delay or drop data but cannot alter or invent it. The gateway reports its own health on its own `up/state` topic.

**Compact readings.** To fit LoRa payloads, a reading may be an array `[metric, value, channel]` (or `[metric, value, channel, cal]`) instead of an object. The metric may be a short code:

| Code | Metric | Code | Metric | Code | Metric |
|---|---|---|---|---|---|
| `at` | air.temperature | `ah` | air.humidity | `ac` | air.co2 |
| `pm` | produce.moisture | `pr` | produce.moisture_raw | `pt` | produce.temperature |
| `pw` | produce.weight | `sm` | security.motion | `sd` | security.door |
| `wt` | water.temperature | `wp` | water.ph | `wd` | water.do |
| `we` | water.ec | `wl` | water.level | `sl` | soil.moisture |
| `kt` | kiln.temperature | `fm` | feedstock.mass | `bm` | biochar.mass |
| `st` | stove.temperature | `se` | stove.energy | `lm` | lpg.mass |
| `so` | solar.energy | `sp` | solar.power | `bs` | power.battery_soc |
| `pv` | power.voltage | `es` | equipment.state | `al` | appliance.locked |
| `ad` | appliance.door_opens | | | | |

Example compact body: `{"v":1,"dev":"CK-000123","seq":88,"ts":1763022600,"up":5000,"buf":true,"r":[["st",182.5,"s1"],["bs",88,"bat"]]}`
