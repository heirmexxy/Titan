// Copy to config.h and fill in. Never commit config.h with real values.
#pragma once

#define FW_VERSION   "2.1.0-titan"
#define DEVICE_ID    "WG-000001"                       // printed on the case; registered in Titan first
#define TITAN_URL    "https://titan.kitovu.com.ng"
#define MQTT_HOST    "mqtt.titan.kitovu.com.ng"
// Titan's firmware signing public key (base64url). Copy it from Admin > Firmware or GET /api/firmware/public-key.
#define TITAN_FIRMWARE_KEY "PASTE-PUBLIC-KEY-HERE"

// ---------- Connection: choose one ----------
#define TITAN_LINK_WIFI 1
#define TITAN_LINK_GSM  2
#define TITAN_LINK      TITAN_LINK_WIFI                  // or TITAN_LINK_GSM for sites without reliable Wi-Fi

// Wi-Fi
#define WIFI_SSID    "warehouse-wifi"
#define WIFI_PASS    "change-me"

// GSM: SIMCom SIM7600 or A7670 (4G Cat-1, falls back to 2G where the operator still runs it).
// The modem model must be set before TinyGSM is included. A7670 boards work with the SIM7600 driver in TinyGSM;
// if yours does not, use TINY_GSM_MODEM_A7672X with TinyGSM 0.12 or later.
#define TINY_GSM_MODEM_SIM7600
#define TINY_GSM_RX_BUFFER 1024
#define GSM_RX       16                                 // ESP32 pin wired to the modem's TX: match your board
#define GSM_TX       17                                 // ESP32 pin wired to the modem's RX
#define GSM_PWRKEY   18                                 // modem PWRKEY (LilyGO T-SIM7600 / T-A7670 boards use their own pins: check)
#define GSM_BAUD     115200
#define GSM_SIM_PIN  ""                                 // usually empty
// APN for the SIM's network. Common Nigerian APNs (confirm with the operator):
//   MTN "web.gprs.mtnnigeria.net" · Airtel "internet.ng.airtel.com" · Glo "gloflat" · 9mobile "9mobile"
#define GSM_APN      "web.gprs.mtnnigeria.net"
#define GSM_USER     ""
#define GSM_PASS     ""

// ---------- Pins (keep clear of the modem pins above) ----------
#define PIN_DHT       4
#define PIN_PIR       27
#define PIN_MOISTURE  34
#define PIN_BUZZER    26

// Root certificates that sign Titan's TLS certificates (Let's Encrypt). Include BOTH ISRG Root X1 and ISRG Root X2,
// one after the other, from https://letsencrypt.org/certificates/ so a change of Let's Encrypt chain does not cut devices off.
// Pin roots, never the server certificate (it changes every 60–90 days).
static const char TITAN_ROOT_CAS[] = R"PEM(
-----BEGIN CERTIFICATE-----
PASTE ISRG ROOT X1 HERE
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
PASTE ISRG ROOT X2 HERE
-----END CERTIFICATE-----
)PEM";
