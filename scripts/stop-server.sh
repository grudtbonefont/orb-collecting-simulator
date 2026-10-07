#!/usr/bin/env bash
# Stops the server supervisor and node server (player data is flushed to data/players.json on SIGTERM).
cd "$(dirname "$0")/.."
[ -f logs/server-supervisor.pid ] && kill "$(cat logs/server-supervisor.pid)" 2>/dev/null
pkill -TERM -f '^node server.js' 2>/dev/null
rm -f logs/server-supervisor.pid; sleep 1; echo "server stopped"
