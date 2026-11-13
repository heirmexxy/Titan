/*
 * WareGuard firmware: Titan Device Protocol v1 reference implementation (ESP32, Arduino core 3.x).
 *
 * STATUS: reference code, not yet compiled or tested on hardware. It shows exactly what Titan expects:
 * provisioning, Ed25519 signing, envelopes, topics, sequence numbers, offline buffering, config and commands.
 * Keep your existing sensor and LCD code; replace the cloud-connection parts with this.
 *
 * Libraries (Arduino Library Manager unless noted):
 *   PubSubClient (Nick O'Leary) · ArduinoJson 7 · DHT sensor library (Adafruit)
 *   Monocypher 4.x: copy monocypher.c/.h and optional/monocypher-ed25519.c/.h from https://monocypher.org into this sketch folder
 * Board settings for production: enable Flash Encryption, Secure Boot v2 and NVS encryption (see docs/wareguard-firmware-migration.md).
 */
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <LittleFS.h>
#include <DHT.h>
#include <time.h>
#include "mbedtls/base64.h"
#include "esp_random.h"
extern "C" {
#include "monocypher.h"
#include "monocypher-ed25519.h"
}
#include "config.h"   // WIFI_SSID, WIFI_PASS, TITAN_URL, MQTT_HOST, DEVICE_ID, pins, ISRG_ROOT_X1

// ---------- State ----------
Preferences prefs;
WiFiClientSecure tls;
PubSubClient mqtt(tls);
DHT dht(PIN_DHT, DHT22);

uint8_t secretKey[64];          // Ed25519 secret key (seed + public key), never leaves the device
uint8_t publicKey[32];
String keyId, token;
uint32_t seq = 0;               // message sequence number (Protocol §4.1)
uint32_t seqSaved = 0;          // high-water mark stored in NVS
const uint32_t SEQ_STEP = 100;  // persist every 100 messages; on boot skip ahead so numbers are never reused

struct Config { uint32_t cfg = 0, telemetryS = 10, moistureS = 60, heartbeatS = 60; float tMax = NAN, hMax = NAN, mMax = NAN; bool alarm = true; String cal = "maize-cap-v2"; } conf;
uint32_t lastTelemetry = 0, lastMoisture = 0, lastHeartbeat = 0;
int lastMotion = 0;
const char *QUEUE = "/queue.txt";
const size_t QUEUE_MAX = 900 * 1024; // ~72 h of 10 s telemetry at ~300 bytes per envelope

void sendHeartbeat();
void sendEvent(const char *code, const char *ch, const char *sev, const char *msg);

String topic(const char *kind) { return String("titan/v1/") + DEVICE_ID + "/up/" + kind; }

// ---------- base64url (no padding) ----------
String b64url(const uint8_t *data, size_t len) {
  size_t outLen = 0;
  std::unique_ptr<unsigned char[]> out(new unsigned char[4 * ((len + 2) / 3) + 1]);
  mbedtls_base64_encode(out.get(), 4 * ((len + 2) / 3) + 1, &outLen, data, len);
  String s;
  s.reserve(outLen);
  for (size_t i = 0; i < outLen; i++) {
    char c = out[i];
    if (c == '+') c = '-'; else if (c == '/') c = '_'; else if (c == '=') continue;
    s += c;
  }
  return s;
}

// ---------- Sequence numbers ----------
uint32_t nextSeq() {
  seq++;
  if (seq >= seqSaved) { seqSaved = seq + SEQ_STEP; prefs.putUInt("seq", seqSaved); }
  return seq;
}

// ---------- Envelope (Protocol §4) ----------
// Builds the body, signs its exact bytes, and wraps it: {"k":keyId,"p":b64url(body),"s":b64url(sig)}
String envelope(JsonDocument &body, bool buffered) {
  time_t now = time(nullptr);
  body["v"] = 1;
  body["dev"] = DEVICE_ID;
  body["seq"] = nextSeq();
  body["ts"] = now > 1700000000 ? (uint32_t)now : 0;       // 0 if the clock was never set (§10)
  body["up"] = (uint32_t)millis();
  if (body["ts"] == 0) body["upn"] = (uint32_t)millis();    // with buffered sending, set upn when actually sending
  body["buf"] = buffered;
  String bytes;
  serializeJson(body, bytes);
  uint8_t sig[64];
  crypto_ed25519_sign(sig, secretKey, (const uint8_t *)bytes.c_str(), bytes.length());
  return String("{\"k\":\"") + keyId + "\",\"p\":\"" + b64url((const uint8_t *)bytes.c_str(), bytes.length()) + "\",\"s\":\"" + b64url(sig, 64) + "\"}";
}

// ---------- Offline buffer (§9): signed when created, sent oldest first after reconnecting ----------
void enqueue(const char *kind, const String &env, bool isEvent) {
  File f = LittleFS.open(QUEUE, FILE_APPEND);
  if (!f) return;
  if (f.size() > QUEUE_MAX && !isEvent) { f.close(); return; } // full: drop new telemetry, never events (simplified)
  f.print(kind); f.print('\t'); f.println(env);
  f.close();
}

void publishOrQueue(const char *kind, JsonDocument &body, bool isEvent = false) {
  bool online = mqtt.connected();
  String env = envelope(body, !online);
  if (!online || !mqtt.publish(topic(kind).c_str(), env.c_str(), false)) enqueue(kind, env, isEvent);
}

void flushQueue() {
  if (!LittleFS.exists(QUEUE)) return;
  File f = LittleFS.open(QUEUE, FILE_READ);
  while (f.available() && mqtt.connected()) {
    String line = f.readStringUntil('\n');
    int tab = line.indexOf('\t');
    if (tab < 0) continue;
    mqtt.publish(topic(line.substring(0, tab).c_str()).c_str(), line.substring(tab + 1).c_str(), false);
    mqtt.loop();
    delay(200); // at most 5 messages per second (§9)
  }
  bool done = !f.available();
  f.close();
  if (done) LittleFS.remove(QUEUE);
}

// ---------- Provisioning (§11) ----------
bool provision(const String &code) {
  uint8_t seed[32];
  esp_fill_random(seed, sizeof seed);
  crypto_ed25519_key_pair(secretKey, publicKey, seed); // wipes seed
  HTTPClient http;
  WiFiClientSecure c; c.setCACert(ISRG_ROOT_X1);
  http.begin(c, String(TITAN_URL) + "/api/provision");
  http.addHeader("Content-Type", "application/json");
  JsonDocument req;
  req["deviceId"] = DEVICE_ID; req["code"] = code; req["publicKey"] = b64url(publicKey, 32);
  String out; serializeJson(req, out);
  int status = http.POST(out);
  String resp = http.getString();
  http.end();
  if (status != 200) { Serial.printf("Provisioning failed (%d): %s\n", status, resp.c_str()); return false; }
  JsonDocument res; deserializeJson(res, resp);
  keyId = res["keyId"].as<String>(); token = res["token"].as<String>();
  prefs.putBytes("sk", secretKey, 64); prefs.putBytes("pk", publicKey, 32);
  prefs.putString("kid", keyId); prefs.putString("tok", token);
  Serial.printf("Provisioned as %s with key %s\n", DEVICE_ID, keyId.c_str());
  return true;
}

// ---------- Downlinks (§8) ----------
void sendAck(JsonVariantConst ack) {
  JsonDocument body; body["ack"] = ack;
  publishOrQueue("ack", body);
}

void applyConfig(JsonDocument &doc) {
  conf.cfg = doc["cfg"] | conf.cfg;
  conf.telemetryS = doc["interval"]["telemetry_s"] | conf.telemetryS;
  conf.moistureS = doc["interval"]["moisture_s"] | conf.moistureS;
  conf.heartbeatS = doc["interval"]["heartbeat_s"] | conf.heartbeatS;
  conf.tMax = doc["thresholds"]["air.temperature"]["max"] | NAN;
  conf.hMax = doc["thresholds"]["air.humidity"]["max"] | NAN;
  conf.mMax = doc["thresholds"]["produce.moisture"]["max"] | NAN;
  conf.alarm = doc["alarm_enable"] | true;
  if (doc["time"].is<uint32_t>() && time(nullptr) < 1700000000) { timeval tv = { (time_t)doc["time"].as<uint32_t>(), 0 }; settimeofday(&tv, nullptr); }
  String saved; serializeJson(doc, saved); prefs.putString("cfgdoc", saved); // survive reboots
  JsonDocument ack; ack["cfg"] = conf.cfg; ack["ok"] = true;
  sendAck(ack.as<JsonVariantConst>());
}

void handleCommand(JsonDocument &doc) {
  String cmd = doc["cmd"] | "", id = doc["id"] | "";
  JsonDocument ack; ack["id"] = id; ack["ok"] = true;
  if (cmd == "alarm_ack") { digitalWrite(PIN_BUZZER, LOW); }
  else if (cmd == "send_state") { lastHeartbeat = 0; }
  else if (cmd == "time_sync") { timeval tv = { (time_t)(doc["args"]["time"] | 0), 0 }; settimeofday(&tv, nullptr); }
  else if (cmd == "reboot") { sendAck(ack.as<JsonVariantConst>()); mqtt.loop(); delay(500); ESP.restart(); }
  else { ack["ok"] = false; ack["msg"] = "unsupported command"; }
  sendAck(ack.as<JsonVariantConst>());
}

void onMessage(char *t, byte *payload, unsigned int len) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, len)) return;
  String tp(t);
  if (tp.endsWith("/down/config")) applyConfig(doc);
  else if (tp.endsWith("/down/cmd")) handleCommand(doc);
}

// ---------- Connection (§2) ----------
void connectMqtt() {
  static uint32_t backoff = 5000, nextTry = 0;
  if (mqtt.connected() || millis() < nextTry || WiFi.status() != WL_CONNECTED) return;
  String lwt = topic("lwt");
  if (mqtt.connect(DEVICE_ID, DEVICE_ID, token.c_str(), lwt.c_str(), 1, false, "offline", false)) {
    backoff = 5000;
    mqtt.subscribe((String("titan/v1/") + DEVICE_ID + "/down/#").c_str(), 1);
    lastHeartbeat = 0;          // state first (§9) …
    sendHeartbeat();
    flushQueue();               // … then buffered messages
  } else {
    nextTry = millis() + backoff + (esp_random() % 3000);
    backoff = min<uint32_t>(backoff * 2, 300000);
  }
}

// ---------- Sensors ----------
float moistureFromRaw(int raw) {
  // TODO: replace with the calibrated curve for the crop (conf.cal). Example polynomial; coefficients from your calibration.
  return 0.0000012f * raw * raw - 0.0021f * raw + 13.9f;
}

void sendHeartbeat() {
  JsonDocument body;
  body["fw"] = FW_VERSION;
  JsonObject st = body["st"].to<JsonObject>();
  st["net"] = "wifi"; st["rssi"] = WiFi.RSSI(); st["heap"] = ESP.getFreeHeap();
  st["bufq"] = LittleFS.exists(QUEUE) ? (int)(LittleFS.open(QUEUE).size() / 300) : 0;
  st["cfg"] = conf.cfg; st["time"] = time(nullptr) > 1700000000 ? "ntp" : "none";
  st["err"].to<JsonArray>();
  publishOrQueue("state", body);
  lastHeartbeat = millis();
}

void sendEvent(const char *code, const char *ch, const char *sev, const char *msg) {
  JsonDocument body;
  JsonObject ev = body["ev"].to<JsonObject>();
  ev["code"] = code; ev["ch"] = ch; ev["sev"] = sev; ev["msg"] = msg;
  publishOrQueue("event", body, true);
}

void readAndSend() {
  uint32_t now = millis();
  // Motion: report on change, immediately (§6, §7)
  int motion = digitalRead(PIN_PIR);
  if (motion != lastMotion) {
    lastMotion = motion;
    if (motion) sendEvent("intruder_detected", "z1/pir1", "critical", "Motion detected");
  }
  bool due = now - lastTelemetry >= conf.telemetryS * 1000UL || lastTelemetry == 0;
  bool moistureDue = now - lastMoisture >= conf.moistureS * 1000UL || lastMoisture == 0;
  if (!due && !moistureDue) return;

  JsonDocument body;
  JsonArray r = body["r"].to<JsonArray>();
  if (due) {
    float t = dht.readTemperature(), h = dht.readHumidity();
    if (isnan(t) || isnan(h)) sendEvent("sensor_error", "z1/dht22", "warning", "DHT22 read failed");
    else {
      JsonObject a = r.add<JsonObject>(); a["m"] = "air.temperature"; a["v"] = round(t * 10) / 10.0; a["ch"] = "z1/dht22";
      JsonObject b = r.add<JsonObject>(); b["m"] = "air.humidity"; b["v"] = round(h * 10) / 10.0; b["ch"] = "z1/dht22";
    }
    JsonObject m = r.add<JsonObject>(); m["m"] = "security.motion"; m["v"] = motion; m["ch"] = "z1/pir1";
    lastTelemetry = now;
  }
  if (moistureDue) {
    int raw = analogRead(PIN_MOISTURE);
    JsonObject a = r.add<JsonObject>(); a["m"] = "produce.moisture_raw"; a["v"] = raw; a["ch"] = "z1/stack-a/mst1";
    JsonObject b = r.add<JsonObject>(); b["m"] = "produce.moisture"; b["v"] = round(moistureFromRaw(raw) * 10) / 10.0; b["ch"] = "z1/stack-a/mst1"; b["cal"] = conf.cal;
    lastMoisture = now;
  }
  if (r.size()) publishOrQueue("telemetry", body);
  // Local alarm keeps working without the cloud (spec §8): compare against conf.tMax / hMax / mMax and drive PIN_BUZZER here.
}

// ---------- Setup / loop ----------
void setup() {
  Serial.begin(115200);
  pinMode(PIN_PIR, INPUT); pinMode(PIN_BUZZER, OUTPUT);
  dht.begin();
  LittleFS.begin(true);
  prefs.begin("titan", false);
  seqSaved = prefs.getUInt("seq", 0);
  seq = seqSaved;                      // skip ahead past anything possibly used before a reset
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) delay(250);
  configTime(0, 0, "pool.ntp.org", "time.google.com");

  if (prefs.getBytesLength("sk") != 64) {
    Serial.println("Not provisioned. Type the provisioning code from Titan and press Enter:");
    while (true) {
      while (!Serial.available()) delay(50);
      String code = Serial.readStringUntil('\n'); code.trim();
      if (code.length() && provision(code)) break;
    }
  } else {
    prefs.getBytes("sk", secretKey, 64); prefs.getBytes("pk", publicKey, 32);
    keyId = prefs.getString("kid"); token = prefs.getString("tok");
  }
  String saved = prefs.getString("cfgdoc", "");
  if (saved.length()) { JsonDocument d; if (!deserializeJson(d, saved)) { conf.cfg = d["cfg"] | 0; conf.telemetryS = d["interval"]["telemetry_s"] | 10; conf.moistureS = d["interval"]["moisture_s"] | 60; conf.heartbeatS = d["interval"]["heartbeat_s"] | 60; } }

  tls.setCACert(ISRG_ROOT_X1);         // validate the broker certificate (§2)
  mqtt.setServer(MQTT_HOST, 8883);
  mqtt.setBufferSize(2048);            // envelopes are larger than PubSubClient's 256-byte default
  mqtt.setKeepAlive(60);
  mqtt.setCallback(onMessage);
  sendEvent("boot", "", "info", esp_reset_reason() == ESP_RST_POWERON ? "power on" : "reset");
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) WiFi.reconnect();
  connectMqtt();
  mqtt.loop();
  readAndSend();
  if (millis() - lastHeartbeat >= conf.heartbeatS * 1000UL) sendHeartbeat();
  // updateLcd();  // keep your existing LCD code here; it must not depend on the connection
  delay(50);
}
