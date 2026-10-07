#!/usr/bin/env bash
# Restarts only the game server; the tunnel (and its public URL) keeps running.
"$(dirname "$0")/stop-server.sh"; "$(dirname "$0")/start-server.sh"
