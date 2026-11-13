# Titan sensor nodes: reference designs

**For:** hardware engineers · **Status:** Draft v1 · All nodes follow [Device Protocol v1](device-protocol-v1.md).

Customers without their own IoT get a Titan node. Every node shares one base, and each use case adds its own sensor board. The firmware is common: provisioning, Ed25519 signing, offline buffering, config and commands. Only the sensor drivers change.

## 1. Common base

| Part | Choice | Why |
|---|---|---|
| MCU | ESP32-S3 (or ESP32-C3 for low-cost nodes) | Wi-Fi, flash encryption, secure boot v2, enough RAM for TLS |
| Cellular | SIMCom A7670 / SIM7600 (LTE Cat-1, falls back to 2G) | Native TLS 1.2; SIM800-class modems are not supported |
| Clock | DS3231 RTC with coin cell | Correct timestamps through power cuts and while offline |
| Storage | Encrypted NVS for keys; LittleFS ring buffer for messages | ≥ 72 h of buffered data (weeks for cookstove nodes) |
| Power | Mains 5 V, or Li-ion + small solar panel for field nodes | |
| Enclosure | IP65, cable glands, tamper switch on the lid | Tamper switch → `security.tamper` |
| Identity | Device ID printed as text + QR on the case | Installers scan it during provisioning |

**Provisioning on site:** hold the setup button to open a Wi-Fi hotspot with a setup page. The installer enters the Wi-Fi details or the SIM APN, plus the provisioning code from Titan. The node generates its key and calls `/api/provision` (Protocol §11).

## 2. Biochar kiln node (`titan-kiln-v1`)

Measures what a biochar carbon calculation needs from the production side. Lab results are entered in Titan separately.

| Measurement | Sensor | Metric / channel |
|---|---|---|
| Kiln temperature at 2–4 points | Type-K thermocouples (ceramic-sheathed, rated ≥ 1,100 °C) via MAX31856 | `kiln.temperature`, `k1/top`, `k1/middle`, `k1/bottom` |
| Biochar out | Platform scale with RS232/RS485 output, or load cells + HX711 | `biochar.mass`, one reading per weighed bag |
| Feedstock in (optional) | Same scale | `feedstock.mass` |
| Feedstock moisture (optional) | Handheld meter reading entered by the operator, or a probe | `feedstock.moisture` |
| Batch start/end | Two illuminated push buttons | `batch_start` / `batch_end` events, batch number on the node's display |
| Location | GPS module (optional; site location is usually enough) | `location.lat`, `location.lng` |

- **Sampling:** temperature every 30 s while a batch runs and every 5 min otherwise. Weighings are sent when the scale reading is stable.
- **How Titan uses it:** a batch starts and ends with the button events. The "held temperature" is the highest temperature the coolest probe sustained for at least 10 minutes, which sets the permanence factor. Masses are summed per batch. Each number in the calculation links back to the signed messages it came from.

## 3. Cookstove node (`titan-cookstove-v1`)

A small, battery-powered stove use monitor.

| Measurement | Sensor | Metric |
|---|---|---|
| Stove body temperature | NTC thermistor or Type-K thermocouple clipped to the stove body, away from the flame | `stove.temperature` |
| Electric cooker energy (e-cooking) | Pulse-output energy meter or PZEM-004T | `stove.energy` |
| LPG use (LPG stoves) | Load-cell platform under the cylinder | `lpg.mass` |

- **Power:** a single 18650 cell. The MCU sleeps and wakes every 2 minutes to sample. It sends one batch every 6 hours over LTE Cat-1/2G (or via a LoRa gateway, see §5). Target battery life: 6 months or more.
- **How Titan uses it:** cooking sessions are detected when the temperature rises above 60 °C and end when it falls below 45 °C. Sessions under 10 minutes are ignored. All thresholds are set per project. Sessions × the project's baseline fuel parameters give the reductions.
- **Tamper:** a temperature that stays flat for weeks on a stove that's in use is flagged for a field visit.

## 4. Solar / PAYG node (`titan-solar-v1`, `paygo-appliance-v1`)

| Measurement | Source | Metric |
|---|---|---|
| Energy produced, power | Inverter or charge controller over RS485 Modbus (Victron, EPEver, Growatt and similar) or a clamp-on CT meter | `solar.energy`, `solar.power` |
| Battery | Same Modbus link | `power.battery_soc`, `power.voltage` |
| Appliance use (freezer, pump) | Relay feedback or current sensor | `equipment.state`, `equipment.runtime` |
| Lock state | PAYG relay | `appliance.locked` |
| Door openings (cooling) | Reed switch | `appliance.door_opens`, `security.door` |
| Location (mobile assets) | GPS | `location.lat`, `location.lng` |

**Commands:** `paygo.lock` / `paygo.unlock {until}`. The node keeps its own unlock-until time, so it stays correct while offline and locks at expiry even without a connection.

## 5. Many small nodes: LoRa gateway

Where dozens of nodes sit close together (a cookstove programme in one community, a warehouse cluster):

- Nodes use LoRa to reach one gateway with Wi-Fi or GSM. Check the NCC's current band allocation before ordering radios (LoRaWAN regional parameters list Nigeria under EU863–870).
- **Each node still signs its own messages.** The gateway forwards the envelopes unchanged to `titan/v1/<nodeId>/up/...` using its own MQTT login, and is authorised to publish for the nodes assigned to it. A compromised gateway can delay or drop data, but cannot change or invent it.
- Signed envelopes are about 300 bytes. For LoRa, nodes send compact readings with short metric codes inside the signed body (Device Protocol §14). Assign each node to its gateway in Titan (admin or client console → device → "Connects through LoRa gateway").

## 6. Controller node (`titan-controller-v1`)

The base board plus relays (fans, pumps, aerators, valves) and 0–10 V/4–20 mA outputs.

- **Commands:** `relay.set {channel, on}` and `setpoint.set {channel, value}`.
- **Safety:** each output has a safe default (normally off). After `failsafe_s` seconds without contact, the node returns to that default. Automations in Titan switch outputs from readings on any device in the same organisation.

## 7. Bill of materials (indicative, to be priced by the hardware team)

| Node | Main parts |
|---|---|
| Kiln | ESP32-S3, A7670, DS3231, 3× MAX31856 + Type-K probes, RS485 transceiver for the scale, 2 buttons, small display, IP65 box |
| Cookstove | ESP32-C3, A7670 (or LoRa radio), thermistor, 18650 + charger |
| Solar/PAYG | ESP32-S3, A7670, RS485 transceiver, relay, reed switch, GPS (optional) |
| Controller | ESP32-S3, A7670 or Wi-Fi only, 4-channel relay board, analog output board |
