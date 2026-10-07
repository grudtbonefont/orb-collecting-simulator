#!/usr/bin/env bash
cd "$(dirname "$0")/.."
[ -f logs/tunnel.pid ] && kill "$(cat logs/tunnel.pid)" 2>/dev/null
pkill -f 'hostc' 2>/dev/null; pkill -f 'cloudflared tunnel' 2>/dev/null
rm -f logs/tunnel.pid; echo "tunnel stopped"
