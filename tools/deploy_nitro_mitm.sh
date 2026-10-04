#!/usr/bin/env bash
# ============================================================================
# Discord Nitro READY-injection mitmproxy - one-click server deploy
# Run THIS SCRIPT on your LOCAL machine:
#   bash deploy_nitro_mitm.sh USER@SERVER_IP [path/to/addon.py]
#
# What it creates on the server:
#   - venv /root/mitmenv with mitmproxy + zstandard
#   - addon /root/mitm/nitro_addon.py (READY injection + CONNECT basic auth)
#   - random proxy user+password -> /root/mitm/AUTH.txt, /root/mitm/htpasswd
#   - systemd unit nitromitm.service, mitmdump on 127.0.0.1:8888, --no-http2
#   - nginx stream TLS-terminates 443 -> 8888 (bypasses GFW port blocks)
#
# Client side (Loon):
#   [Proxy]  NitroMitm = https,<SERVER_IP>,443,<USER>,"<PASSWORD>",skip-cert-verify=true,always-use-connect=true
#   [Rule]   DOMAIN,gateway.discord.gg,NitroMitm
#   Install & trust /root/mitm/proxy-ca.pem on the phone, then reopen Discord.
# ============================================================================
set -euo pipefail

TARGET="${1:?usage: bash $0 USER@SERVER_IP [addon.py]}"
ADDON_SRC="${2:-$(dirname "$0")/discord_nitro_ready.py}"
NGINX_PORT=443

[ -f "$ADDON_SRC" ] || { echo "addon not found: $ADDON_SRC"; exit 1; }

rem() {
  local b64s
  b64s=$(printf '%s' "$1" | base64 | tr -d '\n')
  printf 'echo %s | base64 -d | bash' "$b64s"
}
run() {
  echo ">>> $2"
  ssh -o BatchMode=yes -o ConnectTimeout=15 "$TARGET" "$(rem "$1")"
}

run '
  set -e
  mkdir -p /root/mitm
' "0/6 server prep"

run '
  set -e
  if [ ! -x /root/mitmenv/bin/mitmdump ]; then
    python3 -m venv /root/mitmenv
    /root/mitmenv/bin/pip install -q mitmproxy zstandard
  fi
  /root/mitmenv/bin/mitmdump --version
' "1/6 install mitmproxy venv"

echo "== 2/6 addon upload =="
ADDB64=$(base64 -w0 "$ADDON_SRC" | tr -d '\n')
ssh -o BatchMode=yes "$TARGET" "echo $ADDB64 | base64 -d > /root/mitm/nitro_addon.py"
run '
  set -e
  /root/mitmenv/bin/python3 -c "import py_compile;py_compile.compile(\"/root/mitm/nitro_addon.py\",doraise=True);print(\"addon syntax OK\")"
  sha256sum /root/mitm/nitro_addon.py
' "verify addon"

run '
  set -e
  PUSER="nitro$(tr -dc a-z0-9 </dev/urandom | head -c 6)"
  PPASS="$(tr -dc A-Za-z0-9 </dev/urandom | head -c 24)"
  HASH=$(openssl passwd -apr1 "$PPASS")
  printf "user=%s\npassword=%s\n" "$PUSER" "$PPASS" > /root/mitm/AUTH.txt
  chmod 600 /root/mitm/AUTH.txt
  printf "%s:%s\n" "$PUSER" "$HASH" > /root/mitm/htpasswd
  chmod 640 /root/mitm/htpasswd
  echo "CREDS-OK user=$PUSER"
' "3/6 generate random credentials"

run '
  set -e
  sed -i "s|^HTPASSWD_PATH = .*|HTPASSWD_PATH = \"/root/mitm/htpasswd\"|" /root/mitm/nitro_addon.py
  /root/mitmenv/bin/python3 -c "import py_compile;py_compile.compile(\"/root/mitm/nitro_addon.py\",doraise=True);print(\"auth path patched\")"
' "4/6 point addon at htpasswd"

run '
  set -e
  cat > /etc/systemd/system/nitromitm.service <<EOF
[Unit]
Description=Discord Nitro READY mitmproxy
After=network.target

[Service]
ExecStart=/root/mitmenv/bin/mitmdump --listen-host 127.0.0.1 --listen-port 8888 --no-http2 -s /root/mitm/nitro_addon.py --set flow_detail=0
Restart=always
RestartSec=3
StandardOutput=append:/root/mitm/stdout.log
StandardError=append:/root/mitm/stdout.log

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now nitromitm
  sleep 2
  systemctl is-active nitromitm
' "5/6 systemd unit"

run '
  set -e
  if nginx -V 2>&1 | grep -q "with-stream=dynamic"; then
    apt-get -y install libnginx-mod-stream >/dev/null 2>&1
  fi
  mkdir -p /etc/nginx/ssl
  if [ ! -f /etc/nginx/ssl/proxy-selfsigned.crt ]; then
    openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
      -keyout /etc/nginx/ssl/proxy-selfsigned.key \
      -out /etc/nginx/ssl/proxy-selfsigned.crt \
      -subj "/CN=nitro-proxy"
  fi
  if ! grep -q "stream {" /etc/nginx/nginx.conf; then
    cat >> /etc/nginx/nginx.conf <<EOF

stream {
    upstream mitm_backend { server 127.0.0.1:8888; }
    server {
        listen ${NGINX_PORT} ssl;
        ssl_certificate /etc/nginx/ssl/proxy-selfsigned.crt;
        ssl_certificate_key /etc/nginx/ssl/proxy-selfsigned.key;
        proxy_pass mitm_backend;
        proxy_timeout 3600s;
        proxy_connect_timeout 30s;
    }
}
EOF
  fi
  nginx -t
  systemctl reload nginx
  ss -ltnp | grep -E ":${NGINX_PORT} |:8888 "
' "6/6 nginx TLS stream -> mitmdump"

INFO='
set -e
cat /root/mitm/AUTH.txt
cp -f /root/.mitmproxy/mitmproxy-ca-cert.pem /root/mitm/proxy-ca.pem
chmod 644 /root/mitm/proxy-ca.pem
echo "CA sha256:"; openssl x509 -in /root/mitm/proxy-ca.pem -noout -fingerprint -sha256
echo "---- E2E self-test ----"
curl -s -o /dev/null -w "no-auth : %{http_code} (expect 407)\n" --max-time 15 -p --proxy-insecure --proxy "https://127.0.0.1:'$NGINX_PORT'" http://example.com/
P="$(grep "^user=" /root/mitm/AUTH.txt | cut -d= -f2-):$(grep "^password=" /root/mitm/AUTH.txt | cut -d= -f2-)"
curl -s --max-time 25 -p --proxy-insecure --proxy "https://${P}@127.0.0.1:'$NGINX_PORT'" https://discord.com/api/v9/gateway
echo
'

echo
echo "=== DEPLOY COMPLETE - copy the client block below ==="
ssh -o BatchMode=yes "$TARGET" "$(rem "$INFO")"
echo
echo "CLIENT SETUP (Loon):"
echo "  scp $TARGET:/root/mitm/proxy-ca.pem ."
echo "  [Proxy]  NitroMitm = https,<SERVER_IP>,$NGINX_PORT,<user>,"<password>",skip-cert-verify=true,always-use-connect=true"
echo "  [Rule]   DOMAIN,gateway.discord.gg,NitroMitm"
echo "  Then: install+trust proxy-ca.pem on iPhone, fully kill & reopen Discord."
echo "  Verify: ssh $TARGET 'grep injected /root/mitm/stdout.log | tail -1'"
