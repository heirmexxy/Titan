# Connecting WareGuard to Titan: step-by-step for the hardware engineer

Do these in order. Each step ends with a check, so problems show up early and one at a time.

**You need:**
- [Device Protocol v1](device-protocol-v1.md)
- the reference firmware in `firmware/wareguard/`
- the device simulator in `tools/simulate-device.ts`

Sensors, the LCD and local alarms stay as they are. Only the cloud-connection code changes.

---

### Step 1. See what a correct device does (no hardware)
Ask Kitovu ops to register a test device in Titan (Admin → Devices → Register) and give you its provisioning code. Then run:

```bash
npx tsx tools/simulate-device.ts provision --url https://titan.kitovu.com.ng --device WG-900001 --code <code>
npx tsx tools/simulate-device.ts run --url https://titan.kitovu.com.ng --device WG-900001 --count 3
npx tsx tools/simulate-device.ts show --device WG-900001
```

**Check:** the device page in Titan shows readings, and `show` prints the exact body bytes and the envelope. Keep that output open. Your firmware must produce the same shapes.

### Step 2. Add the libraries
- From the Arduino Library Manager: PubSubClient, ArduinoJson 7, and the DHT sensor library.
- From [monocypher.org](https://monocypher.org): copy `monocypher.c/.h` and `optional/monocypher-ed25519.c/.h` (version 4.x) into the sketch folder.
- Remove any previous cloud-connection library and its calls.

**Check:** the empty sketch compiles for your ESP32 board.

### Step 3. Fill in `config.h`
Copy `config.example.h` to `config.h`. Set the device ID, Wi-Fi, pins, and paste the ISRG Root X1 certificate from letsencrypt.org/certificates.

**Check:** `config.h` is not committed to git (it's in `.gitignore`).

### Step 4. Provision the real board
Flash the reference sketch, open the serial monitor at 115200 and type the provisioning code. The board:
1. generates its own Ed25519 key
2. calls `/api/provision`
3. stores the key, key ID and token in NVS

**Check:** the serial monitor shows `Provisioned as WG-…`. The device page in Titan shows key `k1` under Signing keys.

### Step 5. Connect and send readings
The board connects to `mqtt.titan.kitovu.com.ng:8883` with its device ID and token, subscribes to its `down/#`, and publishes signed telemetry.

**Check:** the device shows online in Titan and readings appear within one interval. If Titan says `bad_signature`, compare your body and envelope with the simulator's `show` output:
- The signature must cover the exact bytes that are base64url-encoded in `p`.
- Base64url means `-` and `_` instead of `+` and `/`, with no `=` padding.

### Step 6. Wire in your sensors
Replace the example sensor code in `readAndSend()` with yours. Keep the metric keys and channels from the protocol:
- `air.temperature` and `air.humidity` on `z1/dht22`
- `security.motion` on `z1/pir1`
- `produce.moisture_raw` and `produce.moisture` on `z1/stack-a/mst1`, with the `cal` profile

Put the calibrated moisture curve in `moistureFromRaw()`.

**Check:** the values in Titan match the LCD.

### Step 7. Events
Motion should send `intruder_detected` on the change from 0 to 1, immediately. Sensor failures send `sensor_error`.

**Check:** wave at the PIR. An alert opens in Titan within seconds.

### Step 8. Config and commands
In Titan, change the device's telemetry interval and send "Request status" and "Silence alarm".

**Check:** Config history shows the new version as applied, and the command log shows both commands as "done".

### Step 9. Offline behaviour
Unplug the router for 10 minutes, then plug it back in.

**Check:**
- The LCD and alarms kept working.
- After reconnecting, the readings from the outage arrive marked as buffered, with their original times.
- No gap appears in the history chart.

### Step 10. Production build
- Enable **Secure Boot v2**, **Flash Encryption** (release mode) and **NVS encryption** in the ESP-IDF/Arduino build settings. Then the private key and token can't be read off the chip.
- Use a battery-backed RTC (DS3231) if the board lacks one, so buffered readings keep correct time through power cuts.
- For GSM units, use an A7670/SIM7600-class modem with TLS 1.2. Set the GSM intervals in Titan (Reporting frequency).

**Check:** reading the flash with `esptool.py read_flash` shows only encrypted data.

### Step 11. Pilot
Install on two or three units at the pilot warehouses. Watch them for a week on the Titan overview, then roll out.

---

**Notes on the reference sketch**
- It hasn't been compiled or run on hardware yet. Treat it as the specification in code and adapt it to your board.
- Sequence numbers are saved to NVS every 100 messages and skipped ahead on boot, so numbers are never reused after a power cut without wearing out the flash.
- The offline queue is a simple LittleFS file. When it's full it drops new telemetry but keeps events. A ring buffer that drops the *oldest* telemetry is better for production.

## After the first install: updates over the air

From version 2.1 of the reference firmware, WareGuard units update themselves from Titan, so later fixes need no site visit.

1. Before building, copy Titan's firmware public key from **Admin → Firmware** (or `https://titan.kitovu.com.ng/api/firmware/public-key`) into `config.h` as `TITAN_FIRMWARE_KEY`.
2. Use a partition scheme with two OTA slots (Arduino IDE: *Tools → Partition Scheme → Minimal SPIFFS (1.9MB APP with OTA)*), and turn on app rollback (`CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE`).
3. To release an update: raise `FW_VERSION`, build the `.bin` (*Sketch → Export Compiled Binary*), upload it on **Admin → Firmware**, and roll it out. Start with one device, then a batch of 10, then the rest.
4. Each device checks the file's size, SHA-256 and Titan's signature before installing, and rolls back by itself if the new firmware can't reach Titan after restarting. The rollout page shows each device's progress and any failure reason.
