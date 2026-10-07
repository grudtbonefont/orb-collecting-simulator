#!/usr/bin/env bash
# Exposes localhost:3000 publicly. Default: hostc (HTTPS/WebSocket over port 443, no account).
# Cloudflare quick tunnel can be used with TUNNEL=cloudflared (needs outbound port 7844, which is blocked on this box).
cd "$(dirname "$0")/.."
mkdir -p logs
if [ -f logs/tunnel.pid ] && kill -0 "$(cat logs/tunnel.pid)" 2>/dev/null; then echo "Tunnel already running (PID $(cat logs/tunnel.pid)): $(cat tunnel-url.txt 2>/dev/null)"; exit 0; fi
: > logs/tunnel.log
if [ "${TUNNEL:-hostc}" = "cloudflared" ]; then
  CF="${CLOUDFLARED:-$HOME/.local/bin/cloudflared}"
  nohup "$CF" tunnel --no-autoupdate --protocol http2 --url http://localhost:3000 >> logs/tunnel.log 2>&1 &
  PATTERN='https://[a-z0-9-]*\.trycloudflare\.com'
else
  # supervisor loop: restarts the hostc client if it ever exits
  nohup bash -c 'while true; do npx -y hostc@latest 3000; echo "[$(date)] hostc exited, restarting in 3s"; sleep 3; done' >> logs/tunnel.log 2>&1 &
  PATTERN='https://[a-z0-9-]*\.hostc\.app'
fi
echo $! > logs/tunnel.pid
for i in $(seq 1 60); do
  URL=$(grep -o "$PATTERN" logs/tunnel.log | tail -1)
  [ -n "$URL" ] && break; sleep 1
done
echo "$URL" > tunnel-url.txt
echo "Tunnel supervisor PID: $(cat logs/tunnel.pid)"
echo "Public URL: $URL"
