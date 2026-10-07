#!/usr/bin/env bash
# Starts the game server in the background (auto-restarts if it crashes). Port 3000.
cd "$(dirname "$0")/.."
if [ -f logs/server-supervisor.pid ] && kill -0 "$(cat logs/server-supervisor.pid)" 2>/dev/null; then echo "Server already running (supervisor PID $(cat logs/server-supervisor.pid))"; exit 0; fi
nohup bash -c 'while true; do node server.js >> logs/server.log 2>&1; echo "[$(date)] server exited, restarting in 1s" >> logs/server.log; sleep 1; done' > /dev/null 2>&1 &
echo $! > logs/server-supervisor.pid
sleep 1.5
echo "Server supervisor PID: $(cat logs/server-supervisor.pid); node PID: $(pgrep -f '^node server.js' | head -1)"
curl -s http://localhost:3000/api/health; echo
