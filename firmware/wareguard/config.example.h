// Copy to config.h and fill in. Never commit config.h with real values.
#pragma once

#define FW_VERSION   "2.0.0-titan"
#define DEVICE_ID    "WG-000001"                       // printed on the case; registered in Titan first
#define WIFI_SSID    "warehouse-wifi"
#define WIFI_PASS    "change-me"
#define TITAN_URL    "https://titan.kitovu.com.ng"
#define MQTT_HOST    "mqtt.titan.kitovu.com.ng"

#define PIN_DHT       4
#define PIN_PIR       27
#define PIN_MOISTURE  34
#define PIN_BUZZER    26

// Root certificate that signs Titan's TLS certificates (Let's Encrypt "ISRG Root X1").
// Paste the PEM from https://letsencrypt.org/certificates/ (isrgrootx1.pem). Pin the root, not the server certificate.
static const char ISRG_ROOT_X1[] = R"PEM(
-----BEGIN CERTIFICATE-----
PASTE ISRG ROOT X1 HERE
-----END CERTIFICATE-----
)PEM";
