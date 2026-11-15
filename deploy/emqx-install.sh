#!/bin/bash
# One-shot EMQX setup for Titan on a server where Dokploy's Traefik owns 80/443.
# Run as root from /opt/titan:  bash deploy/emqx-install.sh
set -u
cd /opt/titan
EMQX_VERSION=5.8.6
DOMAIN=mqtt.titan.kitovu.com.ng
BR=$(ip -4 -o addr show docker0 | awk '{print $4}' | cut -d/ -f1)
echo "== Titan EMQX setup (bridge $BR)"

# 1. Ports must be free unless EMQX already runs.
if ! systemctl is-active -q emqx; then
  for p in 1883 8083 8883 18083; do
    if ss -ltn | awk '{print $4}' | grep -qE "[:.]$p$"; then echo "STOP: port $p already in use"; exit 1; fi
  done
fi

# 2. Traefik: MQTT over WebSocket on 443, and a certificate for $DOMAIN.
cat > /etc/dokploy/traefik/dynamic/titan-mqtt.yml <<YML
http:
  routers:
    titan-mqtt-web:
      rule: Host(\`$DOMAIN\`)
      entryPoints: [web]
      middlewares: [redirect-to-https]
      service: titan-mqtt
    titan-mqtt:
      rule: Host(\`$DOMAIN\`)
      entryPoints: [websecure]
      service: titan-mqtt
      tls:
        certResolver: letsencrypt
  services:
    titan-mqtt:
      loadBalancer:
        servers:
          - url: http://$BR:8083
YML
echo "OK  Traefik route for $DOMAIN"
curl -s -o /dev/null --max-time 20 "https://$DOMAIN/" || true   # nudges Traefik to request the certificate

# 3. Install EMQX (last Apache-2.0 release).
if ! dpkg -s emqx >/dev/null 2>&1; then
  F=/tmp/emqx-$EMQX_VERSION.deb
  wget -q -O $F "https://www.emqx.com/en/downloads/broker/$EMQX_VERSION/emqx-$EMQX_VERSION-ubuntu24.04-amd64.deb" \
    || wget -q -O $F "https://packagecloud.io/emqx/emqx/packages/ubuntu/noble/emqx_${EMQX_VERSION}_amd64.deb/download.deb"
  apt install -y $F >/dev/null 2>&1 && echo "OK  EMQX $EMQX_VERSION installed" || { echo "STOP: EMQX install failed"; exit 1; }
fi
systemctl stop emqx 2>/dev/null

# 4. Certificate from Traefik into EMQX.
install -m 755 deploy/titan-emqx-cert.py /usr/local/bin/titan-emqx-cert
/usr/local/bin/titan-emqx-cert --wait 120 --no-restart || { echo "STOP: Traefik has not issued the $DOMAIN certificate yet. Check DNS, then run this script again."; exit 1; }
printf '#!/bin/sh\n/usr/local/bin/titan-emqx-cert >/dev/null 2>&1\n' > /etc/cron.daily/titan-emqx-cert && chmod +x /etc/cron.daily/titan-emqx-cert

# 5. Listeners: TLS 8883 public; plain TCP local only; WebSocket only for Traefik; dashboard local only.
if ! grep -q '## titan' /etc/emqx/emqx.conf; then
cat >> /etc/emqx/emqx.conf <<CONF

## titan
dashboard.listeners.http.bind = "127.0.0.1:18083"
listeners.tcp.default.bind = "127.0.0.1:1883"
listeners.ws.default.bind = "$BR:8083"
listeners.wss.default.enable = false
listeners.ssl.default.bind = "0.0.0.0:8883"
listeners.ssl.default.ssl_options.certfile = "/etc/emqx/certs/titan-fullchain.pem"
listeners.ssl.default.ssl_options.keyfile = "/etc/emqx/certs/titan-privkey.pem"
CONF
fi
mkdir -p /etc/systemd/system/emqx.service.d
printf '[Unit]\nAfter=docker.service\nWants=docker.service\n' > /etc/systemd/system/emqx.service.d/titan.conf
systemctl daemon-reload
systemctl enable -q emqx && systemctl restart emqx
for i in $(seq 1 30); do curl -sf http://127.0.0.1:18083/status >/dev/null && break; sleep 2; done
curl -sf http://127.0.0.1:18083/status >/dev/null && echo "OK  EMQX running" || { echo "STOP: EMQX did not start; see: journalctl -u emqx -n 30"; exit 1; }

# 6. Wire EMQX to Titan.
python3 deploy/emqx_setup.py
systemctl restart titan

# 7. Check from outside.
sleep 3
V=$(timeout 8 openssl s_client -connect $DOMAIN:8883 -servername $DOMAIN </dev/null 2>/dev/null | grep -m1 'Verify return code')
echo "TLS 8883: ${V:-no answer (is port 8883 open in the Hostinger firewall?)}"
echo "TITAN: $(systemctl is-active titan)  EMQX: $(systemctl is-active emqx)"
